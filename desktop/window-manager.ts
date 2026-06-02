import { BaseWindow, WebContentsView, dialog, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { RendererBridge } from './renderer-bridge.js';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './command-palette/manager.js';
import { PreviewCursorManager } from './preview-cursor-manager.js';
import { getConfigValue, getGlobalValue, setAgentConfig, clearAgentConfig, removeAgentConfig } from '#shared/settings/config.js';
import { ConfirmationManager } from './confirmation/manager.js';
import { storeGet } from './ipc/store.js';
import { Channels } from './ipc/channels.cjs';
import type { PushMap } from './ipc/schema.js';
import { isLocalAgentContext } from './agent-context.js';
import { AgentContextFactory } from './agent-context-factory.js';
import { AgentOrchestrator } from './agent-orchestrator.js';
import { ActionRegistry } from './shortcuts/registry.js';
import { registerBuiltInActions } from './shortcuts/built-in-actions.js';
import { SystemConfigKeys } from '#shared/system-config/keys.js';


export type { AgentContext } from './agent-context.js';

// Header heights: 30px in compact mode, 36px when tab source is shown (see app.ts).
// Visible cluster height ≈ 12px (colored dots, no halo). Y values align the cluster
// with the visible 12×12 inner rect of the sidebar-toggle SVG icon.
const TRAFFIC_LIGHT_X = 13;
const TRAFFIC_LIGHT_Y_COMPACT = 7;
const TRAFFIC_LIGHT_Y_SOURCE = 10;

function trafficLightFor(showSource: boolean): { x: number; y: number } {
  return { x: TRAFFIC_LIGHT_X, y: showSource ? TRAFFIC_LIGHT_Y_SOURCE : TRAFFIC_LIGHT_Y_COMPACT };
}

function parseShowTabSource(value: unknown): boolean {
  const v = String(value ?? '').toLowerCase();
  if (v === '') return true;
  return !(v === 'false' || v === '0' || v === 'no');
}

function readShowTabSource(cacheRoot?: string | null): boolean {
  const raw = cacheRoot
    ? getConfigValue(cacheRoot, SystemConfigKeys.showTabSource)
    : getGlobalValue(SystemConfigKeys.showTabSource);
  return parseShowTabSource(raw);
}

function readHideTrafficLights(cacheRoot?: string | null): boolean {
  const raw = cacheRoot
    ? getConfigValue(cacheRoot, SystemConfigKeys.hideTrafficLights)
    : getGlobalValue(SystemConfigKeys.hideTrafficLights);
  const v = String(raw ?? '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
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
  private previewCursor: PreviewCursorManager | null = null;
  private isZenMode = false;
  private forceClose = false;

  private readonly clientPath = path.join(import.meta.dirname, 'renderer', 'index.html');

  // Internal modules (wired via late-binding deps so cross-references resolve at call time)
  private readonly factory: AgentContextFactory;
  private readonly orchestrator: AgentOrchestrator;
  private readonly actionRegistry: ActionRegistry;

  constructor() {
    this.actionRegistry = new ActionRegistry();
    registerBuiltInActions(this.actionRegistry, {
      getActiveAgentContext: () => this.orchestrator.getActiveAgentContext(),
      getCommandPalette: () => this.commandPalette,
      getRendererBridge: () => this.rendererBridge,
      getRendererView: () => this.rendererView,
      getIsZenMode: () => this.isZenMode,
      toggleZenMode: () => this.toggleZenMode(),
      switchToNextAgent: (dir) => this.orchestrator.switchToNextAgent(dir),
    });

    this.factory = new AgentContextFactory({
      getMainWindow: () => this.mainWindow,
      getRendererWebContents: () => this.rendererView?.webContents ?? null,
      sendToRenderer: (ch, data) => this.sendToRenderer(ch, data),
      focusMainRendererWindow: () => this.rendererBridge?.focusMainRendererWindow(),
      getCommandPalette: () => this.commandPalette!,
      handleShortcutAction: (action) => this.handleShortcutAction(action),
      getActiveAgentId: () => this.orchestrator.getActiveAgentId(),
      registerTabSender: (id, root) => this.orchestrator.registerTabSender(id, root),
      unregisterTabSender: (id) => this.orchestrator.unregisterTabSender(id),
      onRuntimeDbChange: (root, change) => this.orchestrator.onRuntimeDbChange(root, change),
      clientPath: this.clientPath,
      getOverlayViews: () => this.collectOverlayViews(),
      actionRegistry: this.actionRegistry,
    });

    this.orchestrator = new AgentOrchestrator({
      factory: this.factory,
      sendToRenderer: (ch, data) => this.sendToRenderer(ch, data),
      getRendererWebContents: () => this.rendererView?.webContents ?? null,
      isWindowAvailable: () => !!this.mainWindow && !this.mainWindow.isDestroyed(),
      applyTheme: () => this.applyTheme(),
      applyTrafficLightPosition: () => this.applyTrafficLightPosition(),
      applyTrafficLightVisibility: () => this.applyTrafficLightVisibility(),
      dispatchRendererEvent: (name, detail) => {
        this.rendererBridge?.dispatchRendererCustomEvent(name, detail);
      },
      getIsZenMode: () => this.isZenMode,
      actionRegistry: this.actionRegistry,
    });
  }

  // --- Window creation ---

  async createMainWindow(initialAgentId: string): Promise<void> {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      await this.orchestrator.addAgent(initialAgentId);
      return;
    }

    const window = new BaseWindow({
      show: false,
      icon: path.join(import.meta.dirname, '..', 'icons', 'icon.png'),
      title: 'AgentWFY',
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: trafficLightFor(readShowTabSource()) }
        : {
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f0f0f0',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#808080' : '#999999',
              height: 36,
            },
          }),
    });

    this.mainWindow = window;

    // Renderer content lives in a dedicated WebContentsView attached to the BaseWindow.
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
      getCacheRoot: () => this.orchestrator.getActiveCacheRoot()!,
      rendererBridge: this.rendererBridge,
      getTabViewManager: () => this.orchestrator.getActiveAgentContext()!.tabViewManager,
      getPageTools: () => this.orchestrator.getActiveAgentContext()!.pageTools,
      addAgent: (id) => this.orchestrator.addAgent(id),
      switchAgent: (id) => this.orchestrator.switchAgent(id),
      getInstalledAgentsList: () => this.orchestrator.getInstalledAgentsList(),
      getPluginRegistry: () => this.orchestrator.getActiveLocalAgentContext()?.pluginRegistry ?? null,
      getConfirmation: () => this.confirmation!,
      getChat: () => this.orchestrator.getActiveAgentContext()?.chat ?? null,
      getBackend: () => this.orchestrator.getActiveAgentContext()?.backend ?? null,
      getDisplayShortcut: (actionId) => this.orchestrator.getActiveAgentContext()?.shortcutManager.getDisplayShortcut(actionId) ?? null,
      matchShortcut: (key, meta, ctrl, shift, alt) => this.orchestrator.getActiveAgentContext()?.shortcutManager.match(key, meta, ctrl, shift, alt) ?? null,
      handleShortcutAction: (action) => this.handleShortcutAction(action),
      reloadRenderer: () => {
        const wc = this.rendererView?.webContents;
        if (wc && !wc.isDestroyed()) wc.reload();
      },
      setAgentConfig: async (name, value) => {
        const ctx = this.orchestrator.getActiveAgentContext();
        if (ctx) {
          await ctx.backend.config.set(name, value);
          return;
        }
        setAgentConfig(this.orchestrator.getActiveCacheRoot()!, name, value);
      },
      clearAgentConfig: async (name) => {
        const ctx = this.orchestrator.getActiveAgentContext();
        if (ctx) {
          await ctx.backend.config.clear(name);
          return;
        }
        clearAgentConfig(this.orchestrator.getActiveCacheRoot()!, name);
      },
      removeAgentConfig: async (name) => {
        const ctx = this.orchestrator.getActiveAgentContext();
        if (ctx) {
          await ctx.backend.config.remove(name);
          return;
        }
        removeAgentConfig(this.orchestrator.getActiveCacheRoot()!, name);
      },
      pushProviderState: () => {
        void this.pushActiveProviderState().catch((err) => {
          console.error('[providers] Provider state failed:', err);
        });
      },
    });

    this.confirmation = new ConfirmationManager({
      getMainWindow: () => this.mainWindow!,
    });

    if (process.env.AGENTWFY_PREVIEW_CURSOR) {
      this.previewCursor = new PreviewCursorManager(window);
    }

    // Wire up window events
    rendererView.webContents.on('page-title-updated', (evt) => {
      evt.preventDefault();
    });

    window.on('close', (event) => {
      if (this.forceClose) {
        this.forceClose = false;
        return;
      }

      const { runningTasks, streamingAgents } = this.orchestrator.getActiveWorkCounts();
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

    // When the main window regains focus, ensure a WebContents has focus
    // so before-input-event handlers fire.
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
      for (const ctx of this.orchestrator.getAllContexts()) {
        ctx.tabViewManager.destroyAllTabViews();
        ctx.tabViewManager.clearTrackedViewWebContents();
      }
    });

    rwc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      if (!key || input.isAutoRepeat) return;

      const activeCtx = this.orchestrator.getActiveAgentContext();
      if (!activeCtx) return;

      const action = activeCtx.shortcutManager.match(key, !!input.meta, !!input.control, !!input.shift, !!input.alt);
      if (!action) return;

      event.preventDefault();
      this.handleShortcutAction(action);
    });

    this.orchestrator.addPersistedAgent(initialAgentId);
    await this.orchestrator.initAgentContext(initialAgentId);
    this.orchestrator.activateFirstAgent(initialAgentId);
    this.applyTrafficLightPosition();
    this.applyTrafficLightVisibility();

    rwc.loadURL('app://index.html');
    if (!process.env.AGENTWFY_HEADLESS) window.show();

    // After renderer loads: push all state and start triggers for active agent
    rwc.once('did-finish-load', () => {
      this.orchestrator.startActiveAgent();
    });
  }

  // --- Renderer communication ---

  private sendToRenderer<C extends keyof PushMap>(channel: C, data: PushMap[C]): void {
    const wc = this.rendererView?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send(channel, data);
    }
  }

  private async pushActiveProviderState(): Promise<void> {
    const ctx = this.orchestrator.getActiveAgentContext();
    if (!ctx) return;
    this.sendToRenderer(Channels.providers.stateChanged, await ctx.backend.providers.getState());
  }

  getRendererWebContents(): Electron.WebContents | null {
    return this.rendererView?.webContents ?? null;
  }

  // --- Theme ---

  applyTheme(): void {
    const cacheRoot = this.orchestrator.getActiveCacheRoot();
    const value = cacheRoot
      ? getConfigValue(cacheRoot, SystemConfigKeys.theme, 'system')
      : getGlobalValue(SystemConfigKeys.theme) ?? 'system';
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

  applyTrafficLightPosition(): void {
    if (process.platform !== 'darwin') return;
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    const showSource = readShowTabSource(this.orchestrator.getActiveCacheRoot());
    win.setWindowButtonPosition(trafficLightFor(showSource));
  }

  applyTrafficLightVisibility(): void {
    if (process.platform !== 'darwin') return;
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    const hide = readHideTrafficLights(this.orchestrator.getActiveCacheRoot());
    win.setWindowButtonVisibility(!hide);
  }

  reloadShortcutsForAllAgents(): void {
    for (const ctx of this.orchestrator.getAllContexts()) {
      ctx.shortcutManager.reload();
    }
  }

  // --- Zen mode ---

  setZenMode(value: boolean): void {
    if (this.isZenMode === value) return;
    this.isZenMode = value;
    // Zen mode hides the whole tab area via ancestor display:none. The
    // renderer's bounds-sync chain (ResizeObserver / MutationObserver)
    // can't fire for that mutation, so main collapses every tab view
    // directly.
    for (const ctx of this.orchestrator.getAllContexts()) {
      ctx.tabViewManager.setAllTabsCollapsed(value);
    }
    this.sendToRenderer(Channels.zenMode.changed, this.isZenMode);
  }

  toggleZenMode(): void {
    this.setZenMode(!this.isZenMode);
  }

  // --- Broadcast ---

  broadcastSettingChanged(key: string, value: unknown): void {
    const cpWc = this.commandPalette?.getWebContents();
    if (cpWc && !cpWc.isDestroyed()) {
      cpWc.send(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, { key, value });
    }
    this.sendToRenderer(Channels.app.settingChanged, { key, value });
  }

  // --- Lifecycle ---

  hasActiveWork(): boolean {
    return this.orchestrator.hasActiveWork();
  }

  async showQuitConfirmation(): Promise<boolean> {
    const { runningTasks, streamingAgents } = this.orchestrator.getActiveWorkCounts();
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

  destroyAll(): void {
    this.orchestrator.destroyAll();
    this.commandPalette?.destroy();
    this.confirmation?.destroy();
  }

  // --- Shortcut action dispatch ---

  handleShortcutAction(action: string): void {
    this.actionRegistry.run(this.orchestrator.getActiveAgentId(), action);
  }

  // --- Delegation to orchestrator (preserves main.ts API surface) ---

  getMainWindow(): BaseWindow | null { return this.mainWindow; }
  getActiveAgentId(): string | null { return this.orchestrator.getActiveAgentId(); }
  getActiveCacheRoot(): string | null { return this.orchestrator.getActiveCacheRoot(); }
  getActiveHttpApiPort(): number | null { return this.orchestrator.getActiveHttpApiPort(); }
  getCommandPalette(): CommandPaletteManager { return this.commandPalette!; }
  getConfirmation(): ConfirmationManager { return this.confirmation!; }
  getPreviewCursor(): PreviewCursorManager | null { return this.previewCursor; }

  // WebContentsViews the per-agent tab manager must keep above the
  // selected tab when it reorders the window's child stack. Including
  // the preview cursor here lets bringToFront's early-return correctly
  // treat cursor-above-tab as "already in order" — without it, the
  // cursor's 150ms top-asserting ticker defeats the early-return and
  // every renderer bounds tick blanks the tab.
  private collectOverlayViews(): WebContentsView[] {
    const views: WebContentsView[] = [];
    const palette = this.commandPalette?.getView();
    if (palette) views.push(palette);
    const confirmation = this.confirmation?.getView();
    if (confirmation) views.push(confirmation);
    const cursor = this.previewCursor?.getView();
    if (cursor) views.push(cursor);
    return views;
  }
  getAllContexts() { return this.orchestrator.getAllContexts(); }
  getActiveBackend() { return this.orchestrator.getActiveAgentContext()?.backend ?? null; }

  async getHeadlessPageCount(): Promise<number> {
    const results = await Promise.allSettled(
      this.orchestrator.getAllContexts().map(ctx => ctx.pageTools.getPages({ display: 'headless' })),
    );
    return results.reduce((total, result) => {
      if (result.status !== 'fulfilled') return total;
      return total + result.value.length;
    }, 0);
  }

  getContextForSender(senderId: number) { return this.orchestrator.getContextForSender(senderId); }
  tryGetContextForSender(senderId: number) { return this.orchestrator.tryGetContextForSender(senderId); }
  /** Returns the LocalAgentContext for this sender; throws if the sender's agent is remote.
   *  IPC handlers should prefer typed backend APIs and only reach for local runtime
   *  fields when the operation is genuinely local-only (file IO, in-process runtime). */
  getLocalContextForSender(senderId: number) {
    const ctx = this.orchestrator.getContextForSender(senderId);
    if (!isLocalAgentContext(ctx)) {
      throw new Error('Operation requires a local agent context; sender belongs to a remote agent');
    }
    return ctx;
  }
  getBackendForSender(senderId: number) { return this.orchestrator.getBackendForSender(senderId); }
  getCacheRootForEvent(event: IpcMainInvokeEvent) { return this.orchestrator.getCacheRootForEvent(event); }

  addPersistedAgent(agentId: string) { this.orchestrator.addPersistedAgent(agentId); }
  addAgent(agentId: string) { return this.orchestrator.addAgent(agentId); }
  switchAgent(agentId: string) { return this.orchestrator.switchAgent(agentId); }
  removeAgent(agentId: string) { return this.orchestrator.removeAgent(agentId); }
  stopAgent(agentId: string) { return this.orchestrator.stopAgent(agentId); }
  reorderAgents(fromIndex: number, toIndex: number) { this.orchestrator.reorderAgents(fromIndex, toIndex); }
  getInstalledAgentsList() { return this.orchestrator.getInstalledAgentsList(); }

}

export const windowManager = new WindowManager();

export function getPersistedAgentIds(): string[] {
  const val = storeGet('installedAgents');
  return Array.isArray(val) ? val.filter(v => typeof v === 'string') : [];
}
