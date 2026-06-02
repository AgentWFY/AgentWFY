import fs from 'fs';
import path from 'path';
import type { IpcMainInvokeEvent } from 'electron';
import { isLocalAgentContext, type AgentContext, type LocalAgentContext, type RemoteAgentContext } from './agent-context.js';
import type { AgentContextFactory } from './agent-context-factory.js';
import type { AgentDbChange } from '#shared/db/sqlite.js';
import { setupAgentChatPump } from './ipc/agent-sessions.js';
import { storeSet } from './ipc/store.js';
import { getAgentMeta, getRemoteAgentCacheRoot, removeAgentMeta } from './agent-meta.js';
import { isDefaultAgentPath } from './agent-manager.js';
import { scheduleBackup, rescheduleBackupForAgent } from '#shared/backup-scheduler.js';
import { runCleanup } from '#shared/cleanup.js';
import { getConfigValue } from '#shared/settings/config.js';
import { getViewByName } from '#shared/db/views.js';
import { SystemConfigKeys, PLUGIN_PREFIX } from '#shared/system-config/keys.js';
import { Channels } from './ipc/channels.cjs';
import type { InstalledAgent, SendToRenderer } from './ipc/schema.js';
import type { ActionRegistry } from './shortcuts/registry.js';
import { syncTaskActions, isShortcutKey } from './shortcuts/task-actions.js';

export interface AgentOrchestratorDeps {
  factory: AgentContextFactory;
  sendToRenderer: SendToRenderer;
  getRendererWebContents: () => Electron.WebContents | null;
  isWindowAvailable: () => boolean;
  applyTheme: () => void;
  applyTrafficLightPosition: () => void;
  applyTrafficLightVisibility: () => void;
  dispatchRendererEvent: (eventName: string, detail?: unknown) => void;
  getIsZenMode: () => boolean;
  actionRegistry: ActionRegistry;
}

export class AgentOrchestrator {
  private agentContexts = new Map<string, AgentContext>();
  private activeAgentId: string | null = null;
  private switchingAgentId: string | null = null;
  private switchGeneration = 0;
  private switchSupersedeListeners = new Set<() => void>();
  private persistedAgentIds: string[] = [];
  private tabSenderMap = new Map<number, string>();
  private pendingInits = new Map<string, Promise<AgentContext>>();
  private readonly deps: AgentOrchestratorDeps;

  constructor(deps: AgentOrchestratorDeps) {
    this.deps = deps;
  }

  // --- Agent context lifecycle ---

  async initAgentContext(agentId: string): Promise<AgentContext> {
    if (this.agentContexts.has(agentId)) {
      return this.agentContexts.get(agentId)!;
    }

    const pending = this.pendingInits.get(agentId);
    if (pending) return pending;

    const promise = this.doInit(agentId);
    this.pendingInits.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.pendingInits.delete(agentId);
    }
  }

  private async doInit(agentId: string): Promise<AgentContext> {
    const agentCtx = await this.deps.factory.createContext(agentId);
    this.agentContexts.set(agentId, agentCtx);

    // The chat pump is the single renderer-snapshot pipeline for both
    // local and remote agents. It reads from the per-agent chat controller.
    const rwc = this.deps.getRendererWebContents();
    if (rwc) {
      agentCtx.chatPump = setupAgentChatPump(
        agentCtx.chat,
        rwc,
        () => this.activeAgentId === agentId,
      );
    }

    this.wireBackendEvents(agentCtx);

    if (agentCtx.mode === 'remote') {
      this.wireRemoteStatus(agentCtx);
      return agentCtx;
    }

    agentCtx.sessionManager.resetActive();

    scheduleBackup(agentId).then(() => {
      this.deps.dispatchRendererEvent('agentwfy:backup-changed');
    }).catch((err) => console.error('[backup] Schedule failed:', err));

    runCleanup(agentId).catch((err) => console.error('[cleanup] failed:', err));

    return agentCtx;
  }

  private wireBackendEvents(agentCtx: AgentContext): void {
    agentCtx.eventsUnsubscribe = agentCtx.backend.events.subscribe((event) => {
      if (!this.deps.isWindowAvailable()) return;
      if (this.activeAgentId !== agentCtx.agentId) return;
      if (event.kind === 'task:started') {
        this.deps.sendToRenderer(Channels.tasks.runStarted, event.payload);
      } else if (event.kind === 'task:log') {
        this.deps.sendToRenderer(Channels.tasks.runLog, event.payload);
      } else if (event.kind === 'task:finished') {
        this.deps.sendToRenderer(Channels.tasks.runFinished, event.payload);
      }
    });
  }

  private wireRemoteStatus(agentCtx: RemoteAgentContext): void {
    agentCtx.statusUnsubscribe = agentCtx.backend.status.subscribe((status) => {
      if (this.deps.isWindowAvailable()) this.broadcastSidebarState();
      if (status.state === 'connected' && this.activeAgentId === agentCtx.agentId) {
        void this.pushProviderState(agentCtx);
      }
    });
  }

  private beginSwitchAttempt(): number {
    this.switchGeneration += 1;
    for (const listener of Array.from(this.switchSupersedeListeners)) {
      listener();
    }
    return this.switchGeneration;
  }

  private isCurrentSwitch(generation: number): boolean {
    return this.switchGeneration === generation;
  }

  /** Resolves on 'connected'/'error', or when another switch supersedes this one. */
  private waitForRemoteReady(ctx: RemoteAgentContext, generation: number): Promise<void> {
    return new Promise((resolve) => {
      let unsub: (() => void) | null = null;
      let unsubscribeAfterSubscribe = false;
      let settled = false;
      const onSuperseded = () => {
        if (!this.isCurrentSwitch(generation)) done();
      };
      const done = () => {
        if (settled) return;
        settled = true;
        if (unsub) {
          unsub();
          unsub = null;
        } else {
          unsubscribeAfterSubscribe = true;
        }
        this.switchSupersedeListeners.delete(onSuperseded);
        resolve();
      };

      this.switchSupersedeListeners.add(onSuperseded);
      unsub = ctx.backend.status.subscribe((status) => {
        if (!this.isCurrentSwitch(generation)) { done(); return; }
        if (status.state === 'connected' || status.state === 'error') done();
      });
      if (unsubscribeAfterSubscribe && unsub) {
        unsub();
        unsub = null;
      }
    });
  }

  private destroyAgentContext(agentId: string): void {
    const ctx = this.agentContexts.get(agentId);
    if (!ctx) return;

    this.deps.factory.destroyContext(agentId, ctx);

    // Clean up sender map entries for this agent
    for (const [senderId, id] of this.tabSenderMap) {
      if (id === agentId) {
        this.tabSenderMap.delete(senderId);
      }
    }

    this.agentContexts.delete(agentId);
  }

  // --- Tab sender routing (called by factory via deps) ---

  registerTabSender(webContentsId: number, agentId: string): void {
    this.tabSenderMap.set(webContentsId, agentId);
  }

  unregisterTabSender(webContentsId: number): void {
    this.tabSenderMap.delete(webContentsId);
  }

  // --- Public agent management API ---

  addPersistedAgent(agentId: string): void {
    if (!this.persistedAgentIds.includes(agentId)) {
      this.persistedAgentIds.push(agentId);
    }
  }

  async addAgent(agentId: string): Promise<void> {
    this.addPersistedAgent(agentId);
    this.persistInstalledAgents();
    await this.switchAgent(agentId);
  }

  async switchAgent(agentId: string): Promise<void> {
    if (!this.deps.isWindowAvailable()) return;
    if (agentId === this.activeAgentId) return;
    if (!this.persistedAgentIds.includes(agentId) && !this.agentContexts.has(agentId)) return;

    const switchGeneration = this.beginSwitchAttempt();

    const previousCtx = this.activeAgentId ? this.agentContexts.get(this.activeAgentId) : undefined;

    // Lazy-init: initialize agent context on first switch
    let ctx = this.agentContexts.get(agentId);
    const needsLoadingState = !ctx
      || (ctx.mode === 'remote' && ctx.backend.status.get().state !== 'connected');

    const nextSwitchingAgentId = needsLoadingState ? agentId : null;
    if (this.switchingAgentId !== nextSwitchingAgentId) {
      // Surface loading only for agents that are not ready yet. Ready targets
      // still supersede older attempts via switchGeneration above.
      this.switchingAgentId = nextSwitchingAgentId;
      this.broadcastSidebarState();
    }

    if (!ctx) {
      try {
        ctx = await this.initAgentContext(agentId);
      } catch (err) {
        console.error(`[agent] Failed to initialize agent ${agentId}:`, err);
        if (this.switchingAgentId === agentId) {
          this.switchingAgentId = null;
          this.broadcastSidebarState();
        }
        return;
      }
      if (!this.isCurrentSwitch(switchGeneration)) return;
      if (isLocalAgentContext(ctx)) {
        ctx.triggerEngine.start().then(() => {
          this.broadcastSidebarState(); // refresh HTTP port in status line
        }).catch(err => console.error('[triggers] Start failed:', err));
      }
    }

    // For remote agents, wait until the WebSocket is actually connected
    // before promoting to active. backend.start() schedules the connect but
    // doesn't await the open event, so status can still be 'connecting' here.
    if (ctx.mode === 'remote' && this.switchingAgentId === agentId) {
      const initial = ctx.backend.status.get().state;
      if (initial !== 'connected' && initial !== 'error') {
        await this.waitForRemoteReady(ctx, switchGeneration);
      }
    }

    if (!this.isCurrentSwitch(switchGeneration)) return;
    if (this.switchingAgentId === agentId) {
      this.switchingAgentId = null;
    }
    this.activeAgentId = agentId;
    this.deps.applyTheme();
    this.deps.applyTrafficLightPosition();
    this.deps.applyTrafficLightVisibility();

    // Collapse outgoing agent's views to 0x0 before promoting incoming. If
    // the user then closes the incoming agent's last tab, nothing underneath
    // the z-stack is left at stale bounds to leak through.
    if (previousCtx) {
      previousCtx.tabViewManager.deactivateViews();
    }
    ctx.tabViewManager.activateViews();
    await this.openDefaultViewForContext(ctx);
    this.pushFullState(ctx);
  }

  async removeAgent(agentId: string): Promise<void> {
    if (this.persistedAgentIds.length <= 1) return;

    const wasActive = this.activeAgentId === agentId;

    // Capture the remote cache root before clearing meta — once meta is gone
    // we can't reconstruct the path, and the dir won't be deleted by anything
    // else (isDefaultAgentPath is false for remote agents).
    const meta = getAgentMeta(agentId);
    const remoteCacheRoot = meta.backend === 'remote' && meta.remoteConfig
      ? getRemoteAgentCacheRoot(agentId, meta.remoteConfig)
      : null;

    // Remove from persisted list
    this.persistedAgentIds = this.persistedAgentIds.filter(p => p !== agentId);

    // Destroy context if initialized
    if (this.agentContexts.has(agentId)) {
      this.destroyAgentContext(agentId);
    }
    this.persistInstalledAgents();

    // Clear per-agent meta (backend kind, remote config, token reference).
    // Local agents may not have an entry; removeAgentMeta is a no-op if absent.
    removeAgentMeta(agentId);

    // Delete directory on disk for default agents living in userData
    if (isDefaultAgentPath(agentId)) {
      fs.rm(agentId, { recursive: true, force: true }, () => {});
    }

    // Same idea for the remote mirror cache — context.destroy already closed
    // the SQLite handle (if it was open), so this is safe to delete async.
    if (remoteCacheRoot) {
      fs.rm(remoteCacheRoot, { recursive: true, force: true }, () => {});
    }

    if (wasActive) {
      // Switch to first available agent
      const nextId = this.persistedAgentIds[0];
      if (nextId) {
        this.activeAgentId = null; // Clear so switchAgent doesn't skip
        await this.switchAgent(nextId);
      }
    } else {
      this.broadcastSidebarState();
    }
  }

  /**
   * Tear down an agent's context (workers, DB handle, triggers, WS) but leave
   * it in the persisted sidebar list. The sidebar will render it as
   * uninitialized; switching to it later will re-init via the lazy path.
   * If the agent is currently active, switch to another agent first; refuses
   * if it's the only agent.
   */
  async stopAgent(agentId: string): Promise<void> {
    if (!this.agentContexts.has(agentId)) return;

    if (this.activeAgentId === agentId) {
      const candidates = this.persistedAgentIds.filter(id => id !== agentId);
      if (candidates.length === 0) return; // Can't stop the only agent.

      const originalActiveId = this.activeAgentId;
      this.activeAgentId = null; // So switchAgent doesn't short-circuit.

      let switchedTo: string | null = null;
      for (const candidate of candidates) {
        await this.switchAgent(candidate);
        if (this.activeAgentId === candidate) {
          switchedTo = candidate;
          break;
        }
      }

      if (!switchedTo) {
        // Every fallback candidate failed to initialize. Restore the original
        // active agent rather than destroying its context and leaving the
        // window with no selection.
        this.activeAgentId = originalActiveId;
        return;
      }
    }

    this.destroyAgentContext(agentId);
    this.broadcastSidebarState();
  }

  reorderAgents(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.persistedAgentIds.length) return;
    if (toIndex < 0 || toIndex >= this.persistedAgentIds.length) return;
    if (fromIndex === toIndex) return;
    const newOrder = [...this.persistedAgentIds];
    const [moved] = newOrder.splice(fromIndex, 1);
    const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
    newOrder.splice(insertAt, 0, moved);
    this.persistedAgentIds = newOrder;
    this.persistInstalledAgents();
    this.broadcastSidebarState();
  }

  switchToNextAgent(direction: 1 | -1): void {
    const ids = this.persistedAgentIds;
    if (ids.length <= 1) return;
    const currentIdx = this.activeAgentId ? ids.indexOf(this.activeAgentId) : -1;
    let nextIdx: number;
    if (currentIdx < 0) {
      nextIdx = 0;
    } else {
      nextIdx = (currentIdx + direction + ids.length) % ids.length;
    }
    this.switchAgent(ids[nextIdx]).catch(() => {});
  }

  // --- IPC routing ---

  getContextForSender(senderId: number): AgentContext {
    // Check tab sender map (tab views map to specific agents)
    const agentId = this.tabSenderMap.get(senderId);
    if (agentId) {
      const ctx = this.agentContexts.get(agentId);
      if (ctx) return ctx;
    }

    // Main renderer or command palette → active agent
    const activeCtx = this.getActiveAgentContext();
    if (activeCtx) return activeCtx;

    throw new Error(`No agent context found for sender ${senderId}`);
  }

  tryGetContextForSender(senderId: number): AgentContext | null {
    const agentId = this.tabSenderMap.get(senderId);
    if (agentId) {
      const ctx = this.agentContexts.get(agentId);
      if (ctx) return ctx;
    }
    return this.getActiveAgentContext();
  }

  getCacheRootForEvent(event: IpcMainInvokeEvent): string {
    return this.getContextForSender(event.sender.id).cacheRoot;
  }

  getBackendForSender(senderId: number): AgentContext['backend'] {
    return this.getContextForSender(senderId).backend;
  }

  // --- Initial setup (used by coordinator during first window creation) ---

  /** Set the first agent as active and persist the agent list. */
  activateFirstAgent(agentId: string): void {
    this.activeAgentId = agentId;
    this.persistInstalledAgents();
  }

  /** Push all state, start triggers, and open default view for the active agent (call after renderer loads). */
  startActiveAgent(): void {
    const ctx = this.getActiveAgentContext();
    if (!ctx) return;
    this.pushFullState(ctx);
    ctx.tabViewManager.activateViews();
    this.openDefaultViewForContext(ctx).catch(err => console.error('[default-view]', err));
    if (isLocalAgentContext(ctx)) {
      ctx.triggerEngine.start().then(() => {
        this.broadcastSidebarState(); // refresh HTTP port in status line
      }).catch(err => console.error('[triggers] Initial start failed:', err));
    }
  }

  // --- State queries ---

  getActiveAgentId(): string | null {
    return this.activeAgentId;
  }

  getActiveCacheRoot(): string | null {
    return this.getActiveAgentContext()?.cacheRoot ?? this.activeAgentId;
  }

  getActiveAgentContext(): AgentContext | null {
    if (!this.activeAgentId) return null;
    return this.agentContexts.get(this.activeAgentId) ?? null;
  }

  getActiveLocalAgentContext(): LocalAgentContext | null {
    const ctx = this.getActiveAgentContext();
    return ctx && isLocalAgentContext(ctx) ? ctx : null;
  }

  getInstalledAgentsList(): InstalledAgent[] {
    return this.persistedAgentIds.map(id => {
      const ctx = this.agentContexts.get(id);
      const backendKind: 'local' | 'remote' = ctx?.mode ?? (this.persistedKindFor(id));
      const status = ctx?.mode === 'remote' ? ctx.backend.status.get() : undefined;
      return {
        agentId: id,
        name: path.basename(id),
        active: id === this.activeAgentId,
        switching: id === this.switchingAgentId,
        initialized: this.agentContexts.has(id),
        backend: backendKind,
        ...(backendKind === 'remote'
          ? {
              remoteStatus: status?.state ?? 'disconnected',
              remoteStatusText: status?.message ?? 'Remote agent has not connected yet',
            }
          : {}),
      };
    });
  }

  private persistedKindFor(agentId: string): 'local' | 'remote' {
    // Only consulted before the context is initialized. Once a context exists,
    // ctx.mode is the source of truth.
    return getAgentMeta(agentId).backend;
  }

  getAllContexts(): AgentContext[] {
    return Array.from(this.agentContexts.values());
  }

  getActiveHttpApiPort(): number | null {
    const ctx = this.getActiveAgentContext();
    if (!ctx || !isLocalAgentContext(ctx)) return null;
    return ctx.triggerEngine.getHttpApiPort() ?? null;
  }

  // --- DB change handling ---

  onRuntimeDbChange(agentId: string, change: AgentDbChange): void {
    const agentCtx = this.agentContexts.get(agentId);
    if (!agentCtx) return;

    if (!this.deps.isWindowAvailable()) return;

    if (this.activeAgentId === agentId) {
      // Strip `row` before crossing the IPC boundary: it can hold large
      // view-content blobs that the renderer doesn't consume (it only uses
      // {table, rowId, op} for invalidation).
      const { row: _row, ...envelope } = change;
      this.deps.sendToRenderer(Channels.db.changed, envelope);
    }

    if (change.table === 'views' && (change.op === 'update' || change.op === 'delete')) {
      agentCtx.tabViewManager.markViewChanged(change.rowId as string);
    }

    if (change.table === 'tasks') {
      if (agentCtx.taskActionsReloadDebounceTimer) clearTimeout(agentCtx.taskActionsReloadDebounceTimer);
      agentCtx.taskActionsReloadDebounceTimer = setTimeout(() => {
        syncTaskActions(this.deps.actionRegistry, agentCtx.cacheRoot, agentCtx.backend);
        agentCtx.shortcutManager.reload();
      }, 500);
    }

    if (change.table === 'config') {
      const key = change.rowId as string;
      if (isShortcutKey(key)) {
        agentCtx.shortcutManager.reload();
      }
      if (this.activeAgentId === agentId) {
        if (key === SystemConfigKeys.theme) {
          this.deps.applyTheme();
        }
        if (key === SystemConfigKeys.showTabSource) {
          this.deps.applyTrafficLightPosition();
        }
        if (key === SystemConfigKeys.hideTrafficLights) {
          this.deps.applyTrafficLightVisibility();
        }
        if (key.startsWith(PLUGIN_PREFIX) || key === SystemConfigKeys.provider) {
          this.schedulePushProviderState(agentCtx);
        }
      }
      if (isLocalAgentContext(agentCtx)) {
        rescheduleBackupForAgent(agentId);
      }
    }

    if (!isLocalAgentContext(agentCtx)) return;

    if (change.table === 'triggers') {
      if (agentCtx.triggerReloadDebounceTimer) clearTimeout(agentCtx.triggerReloadDebounceTimer);
      agentCtx.triggerReloadDebounceTimer = setTimeout(() => {
        agentCtx.triggerEngine.reload().catch(err => {
          console.error('[triggers] Reload failed:', err);
        });
      }, 500);
    }

    if (agentCtx.dbChangeDebounceTimer) clearTimeout(agentCtx.dbChangeDebounceTimer);
    agentCtx.dbChangeDebounceTimer = setTimeout(() => {
      if (!this.deps.isWindowAvailable()) return;
      this.deps.dispatchRendererEvent('agentwfy:backup-changed');
    }, 5000);
  }

  // --- Lifecycle ---

  hasActiveWork(): boolean {
    for (const ctx of this.agentContexts.values()) {
      if (!isLocalAgentContext(ctx)) continue;
      if (ctx.taskRunner.runningCount > 0 || ctx.sessionManager.streamingSessionsCount > 0) return true;
    }
    return false;
  }

  getActiveWorkCounts(): { runningTasks: number; streamingAgents: number } {
    let runningTasks = 0;
    let streamingAgents = 0;
    for (const ctx of this.agentContexts.values()) {
      if (!isLocalAgentContext(ctx)) continue;
      runningTasks += ctx.taskRunner.runningCount;
      streamingAgents += ctx.sessionManager.streamingSessionsCount;
    }
    return { runningTasks, streamingAgents };
  }

  destroyAll(): void {
    const ids = Array.from(this.agentContexts.keys());
    for (const id of ids) {
      this.destroyAgentContext(id);
    }
    this.activeAgentId = null;
    this.persistedAgentIds = [];
  }

  // --- Private helpers ---

  /**
   * Push all renderer-visible state for an agent context.
   * Called from startActiveAgent and switchAgent — adding a new piece of
   * renderer state means adding one line here.
   *
   * Order matters:
   *  1. Sidebar broadcast triggers agent-switched in the renderer, which
   *     resets stores with ready=false.
   *  2. Snapshot sets ready=true in the session store.
   *  3. Provider state and zen mode can follow in any order.
   */
  private pushFullState(ctx: AgentContext): void {
    this.broadcastSidebarState();
    ctx.chatPump?.refresh();
    void this.pushProviderState(ctx);
    this.deps.sendToRenderer(Channels.zenMode.changed, this.deps.getIsZenMode());
  }

  private async pushProviderState(ctx: AgentContext): Promise<void> {
    try {
      this.deps.sendToRenderer(
        Channels.providers.stateChanged,
        await ctx.backend.providers.getState(),
      );
    } catch (err) {
      console.error('[providers] Provider state failed:', err);
    }
  }

  private schedulePushProviderState(ctx: AgentContext): void {
    if (ctx.providerStatePushTimer) clearTimeout(ctx.providerStatePushTimer);
    ctx.providerStatePushTimer = setTimeout(() => {
      ctx.providerStatePushTimer = null;
      if (this.activeAgentId !== ctx.agentId) return;
      void this.pushProviderState(ctx);
    }, 100);
  }

  private broadcastSidebarState(): void {
    this.deps.sendToRenderer(Channels.agentSidebar.switched, {
      agentId: this.activeAgentId,
      agents: this.getInstalledAgentsList(),
    });
  }

  private persistInstalledAgents(): void {
    storeSet('installedAgents', this.persistedAgentIds);
  }

  private async openDefaultViewForContext(ctx: AgentContext): Promise<void> {
    try {
      const configValue = getConfigValue(ctx.cacheRoot, SystemConfigKeys.defaultView, 'home');
      const trimmed = typeof configValue === 'string' ? configValue.trim() : '';
      const viewName = trimmed || 'home';
      const view = await getViewByName(ctx.cacheRoot, viewName);
      if (!view) return;
      const state = ctx.tabViewManager.getState();
      if (state.tabs.length > 0) return;
      await ctx.pageTools.openPage({
        source: { type: 'view', name: view.name },
        display: 'foreground',
        title: view.title || view.name,
      });
    } catch (err) {
      console.error('[default-view] Failed to open default view:', err);
    }
  }
}
