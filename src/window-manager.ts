import { BaseWindow, WebContentsView, dialog, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { RendererBridge } from './renderer-bridge.js';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './command-palette/manager.js';
import { PreviewCursorManager } from './preview-cursor/manager.js';
import { getConfigValue, getGlobalValue, setAgentConfig, clearAgentConfig, removeAgentConfig } from './settings/config.js';
import { ConfirmationManager } from './confirmation/manager.js';
import { buildProviderState } from './ipc/providers.js';
import { storeGet } from './ipc/store.js';
import { Channels } from './ipc/channels.cjs';
import type { PushMap } from './ipc/schema.js';
import { AgentContextFactory } from './agent-context-factory.js';
import { AgentOrchestrator } from './agent-orchestrator.js';
import { ActionDispatcher } from './action-dispatcher.js';
import type { ProviderRegistry } from './providers/registry.js';
import { SystemConfigKeys } from './system-config/keys.js';


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

function readShowTabSource(agentRoot?: string | null): boolean {
  const raw = agentRoot
    ? getConfigValue(agentRoot, SystemConfigKeys.showTabSource)
    : getGlobalValue(SystemConfigKeys.showTabSource);
  return parseShowTabSource(raw);
}

function readHideTrafficLights(agentRoot?: string | null): boolean {
  const raw = agentRoot
    ? getConfigValue(agentRoot, SystemConfigKeys.hideTrafficLights)
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
  private readonly actionDispatcher: ActionDispatcher;

  constructor() {
    this.factory = new AgentContextFactory({
      getMainWindow: () => this.mainWindow,
      getRendererWebContents: () => this.rendererView?.webContents ?? null,
      sendToRenderer: (ch, data) => this.sendToRenderer(ch, data),
      focusMainRendererWindow: () => this.rendererBridge?.focusMainRendererWindow(),
      getCommandPalette: () => this.commandPalette!,
      handleShortcutAction: (action) => this.handleShortcutAction(action),
      getActiveAgentRoot: () => this.orchestrator.getActiveAgentRoot(),
      registerTabSender: (id, root) => this.orchestrator.registerTabSender(id, root),
      unregisterTabSender: (id) => this.orchestrator.unregisterTabSender(id),
      onRuntimeDbChange: (root, change) => this.orchestrator.onRuntimeDbChange(root, change),
      clientPath: this.clientPath,
      getOverlayViews: () => this.collectOverlayViews(),
    });

    this.orchestrator = new AgentOrchestrator({
      factory: this.factory,
      sendToRenderer: (ch, data) => this.sendToRenderer(ch, data),
      getRendererWebContents: () => this.rendererView?.webContents ?? null,
      isWindowAvailable: () => !!this.mainWindow && !this.mainWindow.isDestroyed(),
      applyTheme: () => this.applyTheme(),
      applyTrafficLightPosition: () => this.applyTrafficLightPosition(),
      applyTrafficLightVisibility: () => this.applyTrafficLightVisibility(),
      pushProviderState: (root, reg) => this.pushProviderState(root, reg),
      dispatchRendererEvent: (name, detail) => {
        this.rendererBridge?.dispatchRendererCustomEvent(name, detail);
      },
      getIsZenMode: () => this.isZenMode,
    });

    this.actionDispatcher = new ActionDispatcher({
      getActiveAgentContext: () => this.orchestrator.getActiveAgentContext(),
      getCommandPalette: () => this.commandPalette,
      getRendererBridge: () => this.rendererBridge,
      getRendererView: () => this.rendererView,
      getIsZenMode: () => this.isZenMode,
      toggleZenMode: () => this.toggleZenMode(),
      switchToNextAgent: (dir) => this.orchestrator.switchToNextAgent(dir),
    });
  }

  // --- Window creation ---

  async createMainWindow(initialAgentRoot: string): Promise<void> {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      await this.orchestrator.addAgent(initialAgentRoot);
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
      getAgentRoot: () => this.orchestrator.getActiveAgentRoot()!,
      rendererBridge: this.rendererBridge,
      getTabViewManager: () => this.orchestrator.getActiveAgentContext()!.tabViewManager,
      addAgent: (root) => this.orchestrator.addAgent(root),
      getPluginRegistry: () => this.orchestrator.getActiveAgentContext()?.pluginRegistry ?? null,
      getConfirmation: () => this.confirmation!,
      getSessionManager: () => this.orchestrator.getActiveAgentContext()!.sessionManager,
      getDisplayShortcut: (actionId) => this.orchestrator.getActiveAgentContext()?.shortcutManager.getDisplayShortcut(actionId) ?? null,
      matchShortcut: (key, meta, ctrl, shift, alt) => this.orchestrator.getActiveAgentContext()?.shortcutManager.match(key, meta, ctrl, shift, alt) ?? null,
      handleShortcutAction: (action) => this.handleShortcutAction(action),
      reloadRenderer: () => {
        const wc = this.rendererView?.webContents;
        if (wc && !wc.isDestroyed()) wc.reload();
      },
      setAgentConfig: (name, value) => {
        setAgentConfig(this.orchestrator.getActiveAgentRoot()!, name, value);
      },
      clearAgentConfig: (name) => {
        clearAgentConfig(this.orchestrator.getActiveAgentRoot()!, name);
      },
      removeAgentConfig: (name) => {
        removeAgentConfig(this.orchestrator.getActiveAgentRoot()!, name);
      },
      pushProviderState: () => {
        const ctx = this.orchestrator.getActiveAgentContext();
        if (ctx) this.pushProviderState(ctx.agentRoot, ctx.providerRegistry);
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

    this.orchestrator.addPersistedAgent(initialAgentRoot);
    await this.orchestrator.initAgentContext(initialAgentRoot);
    this.orchestrator.activateFirstAgent(initialAgentRoot);
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

  private pushProviderState(agentRoot: string, providerRegistry: ProviderRegistry): void {
    this.sendToRenderer(Channels.providers.stateChanged, buildProviderState(agentRoot, providerRegistry));
  }

  getRendererWebContents(): Electron.WebContents | null {
    return this.rendererView?.webContents ?? null;
  }

  // --- Theme ---

  applyTheme(): void {
    const agentRoot = this.orchestrator.getActiveAgentRoot();
    const value = agentRoot
      ? getConfigValue(agentRoot, SystemConfigKeys.theme, 'system')
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
    const showSource = readShowTabSource(this.orchestrator.getActiveAgentRoot());
    win.setWindowButtonPosition(trafficLightFor(showSource));
  }

  applyTrafficLightVisibility(): void {
    if (process.platform !== 'darwin') return;
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    const hide = readHideTrafficLights(this.orchestrator.getActiveAgentRoot());
    win.setWindowButtonVisibility(!hide);
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
    this.actionDispatcher.handleShortcutAction(action);
  }

  // --- Delegation to orchestrator (preserves main.ts API surface) ---

  getMainWindow(): BaseWindow | null { return this.mainWindow; }
  getActiveAgentRoot(): string | null { return this.orchestrator.getActiveAgentRoot(); }
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

  getContextForSender(senderId: number) { return this.orchestrator.getContextForSender(senderId); }
  tryGetContextForSender(senderId: number) { return this.orchestrator.tryGetContextForSender(senderId); }
  getAgentRootForEvent(event: IpcMainInvokeEvent) { return this.orchestrator.getAgentRootForEvent(event); }

  addPersistedAgent(agentRoot: string) { this.orchestrator.addPersistedAgent(agentRoot); }
  addAgent(agentRoot: string) { return this.orchestrator.addAgent(agentRoot); }
  switchAgent(agentRoot: string) { return this.orchestrator.switchAgent(agentRoot); }
  removeAgent(agentRoot: string) { return this.orchestrator.removeAgent(agentRoot); }
  reorderAgents(fromIndex: number, toIndex: number) { this.orchestrator.reorderAgents(fromIndex, toIndex); }
  getInstalledAgentsList() { return this.orchestrator.getInstalledAgentsList(); }

}

export const windowManager = new WindowManager();

export function getPersistedAgentRoots(): string[] {
  const val = storeGet('installedAgents');
  return Array.isArray(val) ? val.filter(v => typeof v === 'string') : [];
}
