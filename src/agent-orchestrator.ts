import fs from 'fs';
import path from 'path';
import type { IpcMainInvokeEvent } from 'electron';
import type { AgentContext } from './agent-context.js';
import type { AgentContextFactory } from './agent-context-factory.js';
import type { AgentDbChange } from './db/sqlite.js';
import type { ProviderRegistry } from './providers/registry.js';
import { setupAgentStateStreaming } from './ipc/agent-sessions.js';
import { storeSet } from './ipc/store.js';
import { isDefaultAgentPath } from './agent-manager.js';
import { scheduleBackup, rescheduleBackupForAgent } from './backup.js';
import { runCleanup } from './cleanup.js';
import { getConfigValue } from './settings/config.js';
import { getViewByName } from './db/views.js';
import { Channels } from './ipc/channels.cjs';

export interface AgentOrchestratorDeps {
  factory: AgentContextFactory;
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  getRendererWebContents: () => Electron.WebContents | null;
  isWindowAvailable: () => boolean;
  applyTheme: () => void;
  pushProviderState: (agentRoot: string, providerRegistry: ProviderRegistry) => void;
  dispatchRendererEvent: (eventName: string, detail?: unknown) => void;
  getIsZenMode: () => boolean;
}

export class AgentOrchestrator {
  private agentContexts = new Map<string, AgentContext>();
  private activeAgentRoot: string | null = null;
  private persistedAgentPaths: string[] = [];
  private tabSenderMap = new Map<number, string>();
  private pendingInits = new Map<string, Promise<AgentContext>>();
  private readonly deps: AgentOrchestratorDeps;

  constructor(deps: AgentOrchestratorDeps) {
    this.deps = deps;
  }

  // --- Agent context lifecycle ---

  async initAgentContext(agentRoot: string): Promise<AgentContext> {
    if (this.agentContexts.has(agentRoot)) {
      return this.agentContexts.get(agentRoot)!;
    }

    const pending = this.pendingInits.get(agentRoot);
    if (pending) return pending;

    const promise = this.doInit(agentRoot);
    this.pendingInits.set(agentRoot, promise);
    try {
      return await promise;
    } finally {
      this.pendingInits.delete(agentRoot);
    }
  }

  private async doInit(agentRoot: string): Promise<AgentContext> {
    const agentCtx = await this.deps.factory.createContext(agentRoot);
    this.agentContexts.set(agentRoot, agentCtx);

    // Gate streaming IPC to active agent (background agents keep processing internally)
    const rwc = this.deps.getRendererWebContents();
    if (rwc) {
      agentCtx.agentStateStreamingCleanup = setupAgentStateStreaming(
        agentCtx.sessionManager, rwc, () => this.activeAgentRoot === agentRoot
      );
    }
    agentCtx.sessionManager.resetActive();

    // Schedule backup
    scheduleBackup(agentRoot).then(() => {
      this.deps.dispatchRendererEvent('agentwfy:backup-changed');
    }).catch((err) => console.error('[backup] Schedule failed:', err));

    // Cleanup
    runCleanup(agentRoot).catch((err) => console.error('[cleanup] failed:', err));

    return agentCtx;
  }

  private destroyAgentContext(agentRoot: string): void {
    const ctx = this.agentContexts.get(agentRoot);
    if (!ctx) return;

    this.deps.factory.destroyContext(agentRoot, ctx);

    // Clean up sender map entries for this agent
    for (const [senderId, root] of this.tabSenderMap) {
      if (root === agentRoot) {
        this.tabSenderMap.delete(senderId);
      }
    }

    this.agentContexts.delete(agentRoot);
  }

  // --- Tab sender routing (called by factory via deps) ---

  registerTabSender(webContentsId: number, agentRoot: string): void {
    this.tabSenderMap.set(webContentsId, agentRoot);
  }

  unregisterTabSender(webContentsId: number): void {
    this.tabSenderMap.delete(webContentsId);
  }

  // --- Public agent management API ---

  addPersistedAgent(agentRoot: string): void {
    if (!this.persistedAgentPaths.includes(agentRoot)) {
      this.persistedAgentPaths.push(agentRoot);
    }
  }

  async addAgent(agentRoot: string): Promise<void> {
    this.addPersistedAgent(agentRoot);
    this.persistInstalledAgents();
    await this.switchAgent(agentRoot);
  }

  async switchAgent(agentRoot: string): Promise<void> {
    if (!this.deps.isWindowAvailable()) return;
    if (agentRoot === this.activeAgentRoot) return;
    if (!this.persistedAgentPaths.includes(agentRoot) && !this.agentContexts.has(agentRoot)) return;

    const prevRoot = this.activeAgentRoot;

    // Lazy-init: initialize agent context on first switch
    let ctx = this.agentContexts.get(agentRoot);
    if (!ctx) {
      try {
        ctx = await this.initAgentContext(agentRoot);
      } catch (err) {
        console.error(`[agent] Failed to initialize agent ${agentRoot}:`, err);
        return;
      }
      ctx.triggerEngine.start().then(() => {
        this.broadcastSidebarState(); // refresh HTTP port in status line
      }).catch(err => console.error('[triggers] Start failed:', err));
      this.openDefaultViewForContext(ctx).catch(err => console.error('[default-view]', err));
    }

    // Hide previous agent's views (after successful init to avoid blank state on failure)
    if (prevRoot && prevRoot !== agentRoot) {
      const prevCtx = this.agentContexts.get(prevRoot);
      if (prevCtx) {
        prevCtx.tabViewManager.hideAllViews();
      }
    }

    this.activeAgentRoot = agentRoot;
    this.deps.applyTheme();

    ctx.tabViewManager.showAllViews();

    this.pushFullState(ctx);
  }

  async removeAgent(agentRoot: string): Promise<void> {
    if (this.persistedAgentPaths.length <= 1) return;

    const wasActive = this.activeAgentRoot === agentRoot;

    // Remove from persisted list
    this.persistedAgentPaths = this.persistedAgentPaths.filter(p => p !== agentRoot);

    // Destroy context if initialized
    if (this.agentContexts.has(agentRoot)) {
      this.destroyAgentContext(agentRoot);
    }
    this.persistInstalledAgents();

    // Delete directory on disk for default agents living in userData
    if (isDefaultAgentPath(agentRoot)) {
      fs.rm(agentRoot, { recursive: true, force: true }, () => {});
    }

    if (wasActive) {
      // Switch to first available agent
      const nextRoot = this.persistedAgentPaths[0];
      if (nextRoot) {
        this.activeAgentRoot = null; // Clear so switchAgent doesn't skip
        await this.switchAgent(nextRoot);
      }
    } else {
      this.broadcastSidebarState();
    }
  }

  reorderAgents(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.persistedAgentPaths.length) return;
    if (toIndex < 0 || toIndex >= this.persistedAgentPaths.length) return;
    if (fromIndex === toIndex) return;
    const newOrder = [...this.persistedAgentPaths];
    const [moved] = newOrder.splice(fromIndex, 1);
    const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
    newOrder.splice(insertAt, 0, moved);
    this.persistedAgentPaths = newOrder;
    this.persistInstalledAgents();
    this.broadcastSidebarState();
  }

  switchToNextAgent(direction: 1 | -1): void {
    const paths = this.persistedAgentPaths;
    if (paths.length <= 1) return;
    const currentIdx = this.activeAgentRoot ? paths.indexOf(this.activeAgentRoot) : -1;
    let nextIdx: number;
    if (currentIdx < 0) {
      nextIdx = 0;
    } else {
      nextIdx = (currentIdx + direction + paths.length) % paths.length;
    }
    this.switchAgent(paths[nextIdx]).catch(() => {});
  }

  // --- IPC routing ---

  getContextForSender(senderId: number): AgentContext {
    // Check tab sender map (tab views map to specific agents)
    const agentRoot = this.tabSenderMap.get(senderId);
    if (agentRoot) {
      const ctx = this.agentContexts.get(agentRoot);
      if (ctx) return ctx;
    }

    // Main renderer or command palette → active agent
    const activeCtx = this.getActiveAgentContext();
    if (activeCtx) return activeCtx;

    throw new Error(`No agent context found for sender ${senderId}`);
  }

  tryGetContextForSender(senderId: number): AgentContext | null {
    const agentRoot = this.tabSenderMap.get(senderId);
    if (agentRoot) {
      const ctx = this.agentContexts.get(agentRoot);
      if (ctx) return ctx;
    }
    return this.getActiveAgentContext();
  }

  getAgentRootForEvent(event: IpcMainInvokeEvent): string {
    return this.getContextForSender(event.sender.id).agentRoot;
  }

  // --- Initial setup (used by coordinator during first window creation) ---

  /** Set the first agent as active and persist the agent list. */
  activateFirstAgent(agentRoot: string): void {
    this.activeAgentRoot = agentRoot;
    this.persistInstalledAgents();
  }

  /** Push all state, start triggers, and open default view for the active agent (call after renderer loads). */
  startActiveAgent(): void {
    const ctx = this.getActiveAgentContext();
    if (!ctx) return;
    this.pushFullState(ctx);
    ctx.triggerEngine.start().then(() => {
      this.broadcastSidebarState(); // refresh HTTP port in status line
    }).catch(err => console.error('[triggers] Initial start failed:', err));
    this.openDefaultViewForContext(ctx).catch(err => console.error('[default-view]', err));
  }

  // --- State queries ---

  getActiveAgentRoot(): string | null {
    return this.activeAgentRoot;
  }

  getActiveAgentContext(): AgentContext | null {
    if (!this.activeAgentRoot) return null;
    return this.agentContexts.get(this.activeAgentRoot) ?? null;
  }

  getInstalledAgentsList(): Array<{ path: string; name: string; active: boolean; initialized: boolean }> {
    return this.persistedAgentPaths.map(root => ({
      path: root,
      name: path.basename(root),
      active: root === this.activeAgentRoot,
      initialized: this.agentContexts.has(root),
    }));
  }

  getAllContexts(): AgentContext[] {
    return Array.from(this.agentContexts.values());
  }

  getActiveHttpApiPort(): number | null {
    const ctx = this.getActiveAgentContext();
    return ctx?.triggerEngine.getHttpApiPort() ?? null;
  }

  // --- DB change handling ---

  onRuntimeDbChange(agentRoot: string, change: AgentDbChange): void {
    const agentCtx = this.agentContexts.get(agentRoot);
    if (!agentCtx) return;

    if (!this.deps.isWindowAvailable()) return;

    if (this.activeAgentRoot === agentRoot) {
      this.deps.sendToRenderer('db:changed', change);
    }

    if (change.table === 'views' && (change.op === 'update' || change.op === 'delete')) {
      agentCtx.tabViewManager.markViewChanged(change.rowId as string);
    }

    if (change.table === 'config') {
      rescheduleBackupForAgent(agentRoot);
      agentCtx.shortcutManager.reload(agentRoot);
      if (this.activeAgentRoot === agentRoot) {
        this.deps.applyTheme();
        const key = change.rowId as string;
        if (key.startsWith('plugin.') || key === 'system.provider') {
          this.deps.pushProviderState(agentRoot, agentCtx.providerRegistry);
        }
      }
    }

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
      if (ctx.taskRunner.runningCount > 0 || ctx.sessionManager.streamingSessionsCount > 0) return true;
    }
    return false;
  }

  getActiveWorkCounts(): { runningTasks: number; streamingAgents: number } {
    let runningTasks = 0;
    let streamingAgents = 0;
    for (const ctx of this.agentContexts.values()) {
      runningTasks += ctx.taskRunner.runningCount;
      streamingAgents += ctx.sessionManager.streamingSessionsCount;
    }
    return { runningTasks, streamingAgents };
  }

  destroyAll(): void {
    const roots = Array.from(this.agentContexts.keys());
    for (const root of roots) {
      this.destroyAgentContext(root);
    }
    this.activeAgentRoot = null;
    this.persistedAgentPaths = [];
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
    this.deps.sendToRenderer(Channels.agent.snapshot, ctx.sessionManager.getSnapshot());
    this.deps.pushProviderState(ctx.agentRoot, ctx.providerRegistry);
    this.deps.sendToRenderer(Channels.zenMode.changed, this.deps.getIsZenMode());
  }

  private broadcastSidebarState(): void {
    this.deps.sendToRenderer(Channels.agentSidebar.switched, {
      agentRoot: this.activeAgentRoot,
      agents: this.getInstalledAgentsList(),
    });
  }

  private persistInstalledAgents(): void {
    storeSet('installedAgents', this.persistedAgentPaths);
  }

  private async openDefaultViewForContext(ctx: AgentContext): Promise<void> {
    try {
      const configValue = getConfigValue(ctx.agentRoot, 'system.default-view', 'home');
      const trimmed = typeof configValue === 'string' ? configValue.trim() : '';
      const viewName = trimmed || 'home';
      const view = await getViewByName(ctx.agentRoot, viewName);
      if (!view) return;
      const state = ctx.tabViewManager.getState();
      if (state.tabs.length > 0) return;
      await ctx.tabViewManager.openTabHandler({
        viewName: view.name,
        title: view.title || view.name,
      });
    } catch (err) {
      console.error('[default-view] Failed to open default view:', err);
    }
  }
}
