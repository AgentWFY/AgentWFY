import { BaseWindow, WebContentsView, dialog, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import { RendererBridge } from './renderer-bridge.js';
import { TabViewManager } from './tab-views/manager.js';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './command-palette/manager.js';
import { getConfigValue, getGlobalValue, setAgentConfig } from './settings/config.js';
import { ShortcutManager } from './shortcuts/manager.js';
import { createOpenAICompatibleFactory } from './providers/openai_compatible.js';
import { TriggerEngine } from './triggers/engine.js';
import { EventBus } from './event-bus.js';
import { AgentSessionManager } from './agent/session_manager.js';
import { TaskRunner } from './task-runner/task_runner.js';
import { getOrCreateRuntime, disposeRuntime } from './ipc/exec-js.js';
import type { AgentTabTools } from './ipc/tabs.js';
import { setupAgentStateStreaming } from './ipc/agent-sessions.js';
import { storeGet, storeSet } from './ipc/store.js';
import {
  ensureAgentRuntimeBootstrap,
  isDefaultAgentPath,
} from './agent-manager.js';
import { runCleanup } from './cleanup.js';
import { scheduleBackup, stopBackupSchedulerForAgent, rescheduleBackupForAgent } from './backup.js';
import type { AgentDbChange } from './db/sqlite.js';
import { closeAgentDb, getOrCreateAgentDb } from './db/agent-db.js';
import { getViewByName } from './db/views.js';
import { loadPlugins } from './plugins/loader.js';
import type { PluginRegistry } from './plugins/registry.js';
import { ProviderRegistry } from './providers/registry.js';
import { buildProviderState } from './ipc/providers.js';
import { ConfirmationManager } from './confirmation/manager.js';
import { FunctionRegistry } from './runtime/function_registry.js';
import { registerAllBuiltInFunctions } from './runtime/functions/index.js';
import type { JsRuntime } from './runtime/js_runtime.js';
import { Channels } from './ipc/channels.js';
import { createViewProtocolHandler } from './protocol/view-handler.js';

/** Per-agent context (everything that is agent-specific). */
export interface AgentContext {
  agentRoot: string;
  eventBus: EventBus;
  tabViewManager: TabViewManager;
  triggerEngine: TriggerEngine;
  pluginRegistry: PluginRegistry | null;
  providerRegistry: ProviderRegistry;
  functionRegistry: FunctionRegistry;
  sessionManager: AgentSessionManager;
  taskRunner: TaskRunner;
  jsRuntime: JsRuntime;
  shortcutManager: ShortcutManager;
  agentStateStreamingCleanup: (() => void) | null;
  dbChangeDebounceTimer: ReturnType<typeof setTimeout> | null;
  triggerReloadDebounceTimer: ReturnType<typeof setTimeout> | null;
  tabTools: AgentTabTools;
}

function buildActiveWorkWarning(runningTasks: number, streamingAgents: number, action: string): string {
  const parts: string[] = [];
  if (streamingAgents > 0) parts.push(`${streamingAgents} agent${streamingAgents > 1 ? 's' : ''} streaming`);
  if (runningTasks > 0) parts.push(`${runningTasks} task${runningTasks > 1 ? 's' : ''} running`);
  const verb = (runningTasks + streamingAgents) === 1 ? 'is' : 'are';
  return `There ${verb} ${parts.join(' and ')}. ${action} will stop them.`;
}

class WindowManager {
  // Shared single window + components
  private mainWindow: BaseWindow | null = null;
  private rendererView: WebContentsView | null = null;
  private rendererBridge: RendererBridge | null = null;
  private commandPalette: CommandPaletteManager | null = null;
  private confirmation: ConfirmationManager | null = null;

  // Agent contexts (initialized agents only)
  private agentContexts = new Map<string, AgentContext>(); // agentRoot → AgentContext
  private activeAgentRoot: string | null = null;

  // All known agent paths (includes uninitialized agents shown in sidebar)
  private persistedAgentPaths: string[] = [];

  // IPC routing: webContents.id → agentRoot (for tab views / child webcontents)
  private tabSenderMap = new Map<number, string>();

  // Per-agent sessions for protocol isolation
  private agentSessions = new Map<string, Electron.Session>(); // agentRoot → Session

  private readonly clientPath = path.join(import.meta.dirname, 'renderer', 'index.html');

  private forceClose = false;
  private isZenMode = false;

  private pendingInits = new Map<string, Promise<AgentContext>>();

  // --- Window creation (single window) ---

  async createMainWindow(initialAgentRoot: string): Promise<void> {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      await this.addAgent(initialAgentRoot);
      return;
    }

    const window = new BaseWindow({
      show: false,
      icon: path.join(import.meta.dirname, '..', 'icons', 'icon.png'),
      title: 'AgentWFY',
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 13, y: 12 } }
        : {
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f0f0f0',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#808080' : '#999999',
              height: 36,
            },
          }),
    });

    this.mainWindow = window;

    // Renderer content lives in a dedicated WebContentsView attached to the
    // BaseWindow.  BaseWindow has no built-in webContents — all web content
    // is rendered through explicit WebContentsView children.
    const rendererView = new WebContentsView({
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        webSecurity: true,
      },
    });
    window.contentView.addChildView(rendererView, 0);
    const syncRendererBounds = () => {
      if (window.isDestroyed()) return;
      const [w, h] = window.getContentSize();
      rendererView.setBounds({ x: 0, y: 0, width: w, height: h });
    };
    syncRendererBounds();
    this.rendererView = rendererView;

    this.rendererBridge = new RendererBridge({
      getMainWindow: () => this.mainWindow!,
      getRendererWebContents: () => this.rendererView?.webContents ?? null,
    });

    this.commandPalette = new CommandPaletteManager({
      getMainWindow: () => this.mainWindow!,
      getAgentRoot: () => this.activeAgentRoot!,
      rendererBridge: this.rendererBridge,
      getTabViewManager: () => this.getActiveAgentContext()!.tabViewManager,
      addAgent: (root) => this.addAgent(root),
      getPluginRegistry: () => this.getActiveAgentContext()?.pluginRegistry ?? null,
      getConfirmation: () => this.confirmation!,
      getSessionManager: () => this.getActiveAgentContext()!.sessionManager,
      getDisplayShortcut: (actionId) => this.getActiveAgentContext()?.shortcutManager.getDisplayShortcut(actionId) ?? null,
      matchShortcut: (key, meta, ctrl, shift, alt) => this.getActiveAgentContext()?.shortcutManager.match(key, meta, ctrl, shift, alt) ?? null,
      handleShortcutAction: (action) => this.handleShortcutAction(action),
      reloadRenderer: () => {
        const wc = this.rendererView?.webContents;
        if (wc && !wc.isDestroyed()) wc.reload();
      },
    });

    this.confirmation = new ConfirmationManager({
      getMainWindow: () => this.mainWindow!,
    });

    // Wire up window events
    rendererView.webContents.on('page-title-updated', (evt) => {
      evt.preventDefault();
    });

    window.on('close', (event) => {
      if (this.forceClose) {
        this.forceClose = false;
        return;
      }

      const { runningTasks, streamingAgents } = this.getActiveWorkCounts();
      if (runningTasks === 0 && streamingAgents === 0) return;

      event.preventDefault();

      dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Cancel', 'Close'],
        defaultId: 0,
        cancelId: 0,
        title: 'Close Window?',
        message: buildActiveWorkWarning(runningTasks, streamingAgents, 'Closing'),
      }).then(({ response }) => {
        if (response === 1) {
          this.forceClose = true;
          window.close();
        }
      });
    });

    window.on('closed', () => {
      this.destroyAll();
      this.mainWindow = null;
      this.rendererView = null;
      this.rendererBridge = null;
      this.commandPalette = null;
      this.confirmation = null;
    });

    window.on('resize', () => {
      syncRendererBounds();
      this.commandPalette?.syncBounds();
      this.confirmation?.syncBounds();
    });

    // When the main window regains focus (e.g. Cmd+Tab back to the app),
    // ensure a WebContents has focus so before-input-event handlers fire.
    window.on('focus', () => {
      // Don't steal focus from overlay views (command palette, confirmation)
      const cpWc = this.commandPalette?.getWebContents();
      if (cpWc && !cpWc.isDestroyed() && cpWc.isFocused()) return;
      const cfWc = this.confirmation?.getWebContents();
      if (cfWc && !cfWc.isDestroyed() && cfWc.isFocused()) return;

      const rwcRef = this.rendererView?.webContents;
      if (rwcRef && !rwcRef.isDestroyed() && !rwcRef.isFocused()) {
        rwcRef.focus();
      }
    });

    if (process.env.AGENTWFY_HEADLESS) {
      window.setSize(1920, 1080);
    } else {
      window.maximize();
    }

    const rwc = rendererView.webContents;

    rwc.on('will-navigate', (event, url) => {
      if (!url.startsWith('app://')) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });

    rwc.setWindowOpenHandler(({ url }) => {
      if (url && url !== 'about:blank') {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    rwc.on('did-start-loading', () => {
      this.commandPalette?.destroy();
      this.confirmation?.destroy();
      for (const ctx of this.agentContexts.values()) {
        ctx.tabViewManager.destroyAllTabViews();
        ctx.tabViewManager.clearTrackedViewWebContents();
      }
    });

    rwc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      if (!key || input.isAutoRepeat) return;

      const activeCtx = this.getActiveAgentContext();
      if (!activeCtx) return;

      const action = activeCtx.shortcutManager.match(key, !!input.meta, !!input.control, !!input.shift, !!input.alt);
      if (!action) return;

      event.preventDefault();
      this.handleShortcutAction(action);
    });

    this.addPersistedAgent(initialAgentRoot);
    await this.initAgentContext(initialAgentRoot);
    this.activeAgentRoot = initialAgentRoot;
    this.persistInstalledAgents();

    rwc.loadURL('app://index.html');
    if (!process.env.AGENTWFY_HEADLESS) window.show();

    // After renderer loads: start triggers and open default view for active agent
    rwc.once('did-finish-load', () => {
      const ctx = this.getActiveAgentContext();
      if (ctx) {
        ctx.triggerEngine.start().then(() => {
          this.broadcastSidebarState();
        }).catch(err => console.error('[triggers] Initial start failed:', err));
        this.openDefaultViewForContext(ctx).catch(err => console.error('[default-view]', err));
        this.sendToRenderer(Channels.agent.snapshot, ctx.sessionManager.getSnapshot());
        this.sendToRenderer(Channels.providers.stateChanged, buildProviderState(ctx.agentRoot, ctx.providerRegistry));
      }
    });

  }

  // --- Agent context lifecycle ---

  private async initAgentContext(agentRoot: string): Promise<AgentContext> {
    if (this.agentContexts.has(agentRoot)) {
      return this.agentContexts.get(agentRoot)!;
    }

    const pending = this.pendingInits.get(agentRoot);
    if (pending) return pending;

    const promise = this.doInitAgentContext(agentRoot);
    this.pendingInits.set(agentRoot, promise);
    try {
      return await promise;
    } finally {
      this.pendingInits.delete(agentRoot);
    }
  }

  private async doInitAgentContext(agentRoot: string): Promise<AgentContext> {
    const win = this.mainWindow!;

    await ensureAgentRuntimeBootstrap(agentRoot);

    getOrCreateAgentDb(agentRoot);

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(createOpenAICompatibleFactory({
      getConfig: (key, fallback) => getConfigValue(agentRoot, key, fallback),
      setConfig: (key, value) => setAgentConfig(agentRoot, key, value),
    }));

    const functionRegistry = new FunctionRegistry();

    const eventBus = new EventBus();
    const busPublish = (topic: string, data: unknown) => eventBus.publish(topic, data);

    const pluginRegistry = loadPlugins(agentRoot, busPublish, providerRegistry, functionRegistry);

    const agentSession = this.getOrCreateAgentSession(agentRoot);

    const registerSender = (webContentsId: number) => {
      this.tabSenderMap.set(webContentsId, agentRoot);
    };
    const unregisterSender = (webContentsId: number) => {
      this.tabSenderMap.delete(webContentsId);
    };

    const tabViewManager = new TabViewManager({
      getMainWindow: () => this.mainWindow!,
      sendToRenderer: (channel, ...args) => this.sendToRenderer(channel, ...args),
      focusMainRendererWindow: () => this.rendererBridge?.focusMainRendererWindow(),
      matchShortcut: (key, meta, ctrl, shift, alt) => {
        const ctx = this.agentContexts.get(agentRoot);
        return ctx?.shortcutManager.match(key, meta, ctrl, shift, alt) ?? null;
      },
      handleAction: (action) => this.handleShortcutAction(action),
      session: agentSession,
      registerSender,
      unregisterSender,
    });

    const tabTools: AgentTabTools = {
      getTabs: () => tabViewManager.getTabsHandler(),
      openTab: (req: Parameters<TabViewManager['openTabHandler']>[0]) => tabViewManager.openTabHandler(req),
      closeTab: (req: Parameters<TabViewManager['closeTabHandler']>[0]) => tabViewManager.closeTabHandler(req),
      selectTab: (req: Parameters<TabViewManager['selectTabHandler']>[0]) => tabViewManager.selectTabHandler(req),
      reloadTab: (req: Parameters<TabViewManager['reloadTabHandler']>[0]) => tabViewManager.reloadTabHandler(req),
      captureTab: (req: Parameters<TabViewManager['captureTabById']>[0]) => tabViewManager.captureTabById(req),
      getTabConsoleLogs: (req: Parameters<TabViewManager['getTabConsoleLogsById']>[0]) => tabViewManager.getTabConsoleLogsById(req),
      execTabJs: (req: Parameters<TabViewManager['execTabJsById']>[0]) => tabViewManager.execTabJsById(req),
    };

    registerAllBuiltInFunctions(functionRegistry, {
      agentRoot,
      rendererWebContents: this.rendererView!.webContents,
      tabTools,
      onDbChange: (change) => {
        if (win.isDestroyed()) return;
        this.onRuntimeDbChange(agentRoot, change);
      },
      getSessionManager: () => agentCtx.sessionManager,
      getTaskRunner: () => agentCtx.taskRunner,
      getCommandPalette: () => this.commandPalette!,
      eventBus,
      providerRegistry,
    });

    const jsRuntime = getOrCreateRuntime(agentRoot, {
      functionRegistry,
    });

    const sessionManager = new AgentSessionManager({
      agentRoot,
      providerRegistry,
      getJsRuntime: () => jsRuntime,
      busPublish,
    });

    const taskRunner = new TaskRunner({
      agentRoot,
      getJsRuntime: () => jsRuntime,
      busPublish,
      onRunFinished: (payload) => {
        if (!win.isDestroyed() && this.activeAgentRoot === agentRoot) {
          this.sendToRenderer(Channels.tasks.runFinished, payload);
        }
      },
      onRunStarted: (payload) => {
        if (!win.isDestroyed() && this.activeAgentRoot === agentRoot) {
          this.sendToRenderer(Channels.tasks.runStarted, payload);
        }
      },
    });

    const shortcutManager = new ShortcutManager(agentRoot);

    const triggerEngine = new TriggerEngine({
      getAgentRoot: () => agentRoot,
      getPreferredPort: () => Number(getConfigValue(agentRoot, 'system.http-api.port', '9877')),
      startTask: async (taskName, input?, origin?) => {
        const runId = await taskRunner.startTask(taskName, input, origin as any);
        return { runId };
      },
      waitFor: (topic, timeoutMs?) => eventBus.waitFor(topic, timeoutMs),
      busSubscribe: (topic, fn) => eventBus.subscribe(topic, fn),
      busPublish: (topic, data) => eventBus.publish(topic, data),
    });

    const agentCtx: AgentContext = {
      agentRoot,
      eventBus,
      tabViewManager,
      triggerEngine,
      pluginRegistry,
      providerRegistry,
      functionRegistry,
      sessionManager,
      taskRunner,
      jsRuntime,
      shortcutManager,
      agentStateStreamingCleanup: null,
      dbChangeDebounceTimer: null,
      triggerReloadDebounceTimer: null,
      tabTools,
    };

    this.agentContexts.set(agentRoot, agentCtx);

    // Gate streaming IPC to active agent (background agents keep processing internally)
    agentCtx.agentStateStreamingCleanup = setupAgentStateStreaming(
      sessionManager, this.rendererView!.webContents, () => this.activeAgentRoot === agentRoot
    );
    sessionManager.resetActive();

    // Schedule backup
    scheduleBackup(agentRoot).then(() => {
      this.rendererBridge?.dispatchRendererWindowEvent('agentwfy:backup-changed');
    }).catch((err) => console.error('[backup] Schedule failed:', err));

    // Cleanup
    runCleanup(agentRoot).catch((err) => console.error('[cleanup] failed:', err));

    return agentCtx;
  }

  private destroyAgentContext(agentRoot: string): void {
    const ctx = this.agentContexts.get(agentRoot);
    if (!ctx) return;

    ctx.agentStateStreamingCleanup?.();
    ctx.agentStateStreamingCleanup = null;
    ctx.sessionManager.disposeAll().catch((err) => { console.warn('[WindowManager] disposeAll failed:', err) });
    ctx.taskRunner.dispose();
    ctx.eventBus.dispose();

    if (ctx.dbChangeDebounceTimer) {
      clearTimeout(ctx.dbChangeDebounceTimer);
      ctx.dbChangeDebounceTimer = null;
    }
    if (ctx.triggerReloadDebounceTimer) {
      clearTimeout(ctx.triggerReloadDebounceTimer);
      ctx.triggerReloadDebounceTimer = null;
    }

    ctx.pluginRegistry?.deactivateAll();
    ctx.tabViewManager.destroyAllTabViews();
    ctx.tabViewManager.clearTrackedViewWebContents();
    this.stopTriggersForAgentContext(ctx);
    stopBackupSchedulerForAgent(agentRoot);
    disposeRuntime(agentRoot);

    // Clean up sender map entries for this agent
    for (const [senderId, root] of this.tabSenderMap) {
      if (root === agentRoot) {
        this.tabSenderMap.delete(senderId);
      }
    }

    closeAgentDb(agentRoot);

    const agentSession = this.agentSessions.get(agentRoot);
    if (agentSession) {
      agentSession.protocol.unhandle('agentview');
      this.agentSessions.delete(agentRoot);
    }

    this.agentContexts.delete(agentRoot);
  }

  // --- Public agent management API ---

  /** Register an agent path without initializing it (shown in sidebar, lazy-loaded on first switch). */
  addPersistedAgent(agentRoot: string): void {
    if (!this.persistedAgentPaths.includes(agentRoot)) {
      this.persistedAgentPaths.push(agentRoot);
    }
  }

  /** Add an agent and switch to it. Initializes lazily via switchAgent. */
  async addAgent(agentRoot: string): Promise<void> {
    this.addPersistedAgent(agentRoot);
    this.persistInstalledAgents();
    await this.switchAgent(agentRoot);
  }

  async switchAgent(agentRoot: string): Promise<void> {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
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
      ctx.triggerEngine.start().catch(err => console.error('[triggers] Start failed:', err));
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
    this.applyTheme();

    ctx.tabViewManager.showAllViews();

    // Notify renderer (triggers state reset in stores/components)
    this.broadcastSidebarState();

    // Push fresh snapshot so renderer shows current agent state
    const snapshot = ctx.sessionManager.getSnapshot();
    this.sendToRenderer(Channels.agent.snapshot, snapshot);

    this.sendToRenderer(Channels.providers.stateChanged, buildProviderState(agentRoot, ctx.providerRegistry));
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

  private broadcastSidebarState(): void {
    this.sendToRenderer(Channels.agentSidebar.switched, {
      agentRoot: this.activeAgentRoot,
      agents: this.getInstalledAgentsList(),
    });
  }

  private persistInstalledAgents(): void {
    storeSet('installedAgents', this.persistedAgentPaths);
  }

  getInstalledAgentsList(): Array<{ path: string; name: string; active: boolean; initialized: boolean }> {
    return this.persistedAgentPaths.map(root => ({
      path: root,
      name: path.basename(root),
      active: root === this.activeAgentRoot,
      initialized: this.agentContexts.has(root),
    }));
  }

  getActiveAgentRoot(): string | null {
    return this.activeAgentRoot;
  }

  getMainWindow(): BaseWindow | null {
    return this.mainWindow;
  }

  getRendererWebContents(): Electron.WebContents | null {
    return this.rendererView?.webContents ?? null;
  }

  private sendToRenderer(channel: string, ...args: unknown[]): void {
    const wc = this.rendererView?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send(channel, ...args);
    }
  }

  setZenMode(value: boolean): void {
    if (this.isZenMode === value) return;
    this.isZenMode = value;
    this.sendToRenderer(Channels.zenMode.changed, this.isZenMode);
  }

  toggleZenMode(): void {
    this.setZenMode(!this.isZenMode);
  }

  getActiveHttpApiPort(): number | null {
    const ctx = this.getActiveAgentContext();
    return ctx?.triggerEngine.getHttpApiPort() ?? null;
  }

  private getActiveAgentContext(): AgentContext | null {
    if (!this.activeAgentRoot) return null;
    return this.agentContexts.get(this.activeAgentRoot) ?? null;
  }

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
    try {
      return this.getContextForSender(senderId);
    } catch {
      return null;
    }
  }

  getCommandPalette(): CommandPaletteManager {
    return this.commandPalette!;
  }

  getConfirmation(): ConfirmationManager {
    return this.confirmation!;
  }

  getAgentRootForEvent(event: IpcMainInvokeEvent): string {
    return this.getContextForSender(event.sender.id).agentRoot;
  }


  // --- Per-agent session management ---

  private getOrCreateAgentSession(agentRoot: string): Electron.Session {
    let agentSession = this.agentSessions.get(agentRoot);
    if (agentSession) return agentSession;

    agentSession = session.fromPartition(`agent:${agentRoot}`);

    const handler = createViewProtocolHandler({
      agentRoot,
      clientPath: this.clientPath,
    });
    agentSession.protocol.handle('agentview', handler);

    this.agentSessions.set(agentRoot, agentSession);
    return agentSession;
  }

  // --- DB change routing ---

  /** Handle DB changes from runtime functions (exec workers, tasks, views).
   *  Shares the same side-effect logic as onDbChange but doesn't need an IPC event. */
  private onRuntimeDbChange(agentRoot: string, change: AgentDbChange): void {
    const agentCtx = this.agentContexts.get(agentRoot);
    if (!agentCtx) return;

    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    if (this.activeAgentRoot === agentRoot) {
      this.sendToRenderer('db:changed', change);
    }

    if (change.table === 'views' && (change.op === 'update' || change.op === 'delete')) {
      agentCtx.tabViewManager.markViewChanged(change.rowId as string);
    }

    if (change.table === 'config') {
      rescheduleBackupForAgent(agentRoot);
      agentCtx.shortcutManager.reload(agentRoot);
      if (this.activeAgentRoot === agentRoot) this.applyTheme();
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
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
      this.rendererBridge?.dispatchRendererWindowEvent('agentwfy:backup-changed');
    }, 5000);
  }

  onDbChange(event: IpcMainInvokeEvent, change: AgentDbChange): void {
    // Resolve agent root via sender map
    const agentRoot = this.tabSenderMap.get(event.sender.id) ?? this.activeAgentRoot;
    if (!agentRoot) return;

    this.onRuntimeDbChange(agentRoot, change);
  }

  // --- Triggers ---

  private stopTriggersForAgentContext(ctx: AgentContext): void {
    if (ctx.triggerReloadDebounceTimer) {
      clearTimeout(ctx.triggerReloadDebounceTimer);
      ctx.triggerReloadDebounceTimer = null;
    }
    ctx.triggerEngine.stop();
  }

  // --- Lifecycle ---

  hasActiveWork(): boolean {
    for (const ctx of this.agentContexts.values()) {
      if (ctx.taskRunner.runningCount > 0 || ctx.sessionManager.streamingSessionsCount > 0) return true;
    }
    return false;
  }

  async showQuitConfirmation(): Promise<boolean> {
    const { runningTasks, streamingAgents } = this.getActiveWorkCounts();
    if (runningTasks === 0 && streamingAgents === 0) return true;

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Quit AgentWFY?',
      message: buildActiveWorkWarning(runningTasks, streamingAgents, 'Quitting'),
    });
    return response === 1;
  }

  private getActiveWorkCounts(): { runningTasks: number; streamingAgents: number } {
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
    this.commandPalette?.destroy();
    this.confirmation?.destroy();
    this.activeAgentRoot = null;
    this.persistedAgentPaths = [];
  }

  getAllContexts(): AgentContext[] {
    return Array.from(this.agentContexts.values());
  }

  // --- Shortcut action dispatch ---

  handleShortcutAction(action: string): void {
    const activeCtx = this.getActiveAgentContext();
    if (!activeCtx) return;

    switch (action) {
      case 'toggle-command-palette':
        this.commandPalette?.toggle();
        break;
      case 'toggle-agent-chat':
        this.rendererBridge?.dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
        break;
      case 'toggle-task-panel':
        this.rendererBridge?.dispatchRendererWindowEvent('agentwfy:toggle-task-panel');
        break;
      case 'toggle-agent-sidebar':
        this.rendererBridge?.dispatchRendererWindowEvent('agentwfy:toggle-agent-sidebar');
        break;
      case 'toggle-zen-mode':
        this.toggleZenMode();
        break;
      case 'close-current-tab':
        if (this.isZenMode) {
          this.rendererBridge?.dispatchRendererWindowEvent('agentwfy:close-current-session');
        } else {
          activeCtx.tabViewManager.closeCurrentTab();
        }
        break;
      case 'reload-current-tab':
        activeCtx.tabViewManager.reloadCurrentTab();
        break;
      case 'reload-window':
        this.rendererView?.webContents.reload();
        break;
      case 'add-agent':
        this.commandPalette?.runAction({ type: 'add-agent' }).catch(() => {});
        break;
      case 'new-session':
        this.handleNewSession(activeCtx);
        break;
      case 'next-agent':
        this.switchToNextAgent(1);
        break;
      case 'previous-agent':
        this.switchToNextAgent(-1);
        break;
      case 'search-views':
        this.commandPalette?.showFiltered('views ');
        break;
      case 'open-settings':
        this.commandPalette?.show({ screen: 'settings' });
        break;
      case 'toggle-dev-tools':
        this.rendererView?.webContents.toggleDevTools();
        break;
      default:
        if (action.startsWith('switch-to-tab-')) {
          const index = parseInt(action.slice(-1), 10) - 1;
          if (this.isZenMode) {
            this.rendererBridge?.dispatchRendererCustomEvent('agentwfy:switch-to-session', { index });
          } else {
            activeCtx.tabViewManager.switchToTabByIndex(index);
          }
        } else if (action === 'previous-tab') {
          if (this.isZenMode) this.rendererBridge?.dispatchRendererCustomEvent('agentwfy:cycle-session', { direction: -1 });
          else activeCtx.tabViewManager.previousTab();
        } else if (action === 'next-tab') {
          if (this.isZenMode) this.rendererBridge?.dispatchRendererCustomEvent('agentwfy:cycle-session', { direction: 1 });
          else activeCtx.tabViewManager.nextTab();
        }
        break;
    }
  }

  private handleNewSession(ctx: AgentContext): void {
    this.rendererBridge?.dispatchRendererCustomEvent('agentwfy:open-sidebar-panel', { panel: 'agent-chat' });
    if (!ctx.sessionManager.activeIsEmpty) {
      ctx.sessionManager.newSession().catch(() => {});
    }
    // Explicit focus needed when chat panel is already open
    this.rendererBridge?.dispatchRendererWindowEvent('agentwfy:focus-chat-input');
  }

  private switchToNextAgent(direction: 1 | -1): void {
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

  // --- Default view ---

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

  // --- Broadcast ---

  broadcastSettingChanged(key: string, value: unknown): void {
    const cpWc = this.commandPalette?.getWebContents();
    if (cpWc && !cpWc.isDestroyed()) {
      cpWc.send(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, { key, value });
    }
  }

  applyTheme(): void {
    const agentRoot = this.activeAgentRoot;
    const value = agentRoot
      ? getConfigValue(agentRoot, 'system.theme', 'system')
      : getGlobalValue('system.theme') ?? 'system';
    const source = (value === 'light' || value === 'dark') ? value : 'system';
    if (nativeTheme.themeSource !== source) {
      nativeTheme.themeSource = source;
    }
    if (process.platform !== 'darwin' && this.mainWindow && !this.mainWindow.isDestroyed()) {
      const dark = nativeTheme.shouldUseDarkColors;
      this.mainWindow.setTitleBarOverlay({
        color: dark ? '#1a1a1a' : '#f0f0f0',
        symbolColor: dark ? '#808080' : '#999999',
      });
    }
  }
}

export const windowManager = new WindowManager();

export function getPersistedAgentRoots(): string[] {
  const val = storeGet('installedAgents');
  return Array.isArray(val) ? val.filter(v => typeof v === 'string') : [];
}
