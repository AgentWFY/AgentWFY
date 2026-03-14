import { BrowserWindow, nativeTheme, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { RendererBridge } from './renderer-bridge.js';
import { TabViewManager } from './tab-views/manager.js';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './command-palette/manager.js';
import { startHttpApi } from './http-api/server.js';
import type { HttpApiServer } from './http-api/server.js';
import { readAgentHttpPort } from './http-api/agent-config.js';
import { writeLockfile, removeLockfile, cleanStaleLockfile } from './http-api/lockfile.js';
import { TriggerEngine } from './triggers/engine.js';
import { forwardStartTask } from './task-runner/ipc.js';
import { forwardBusWaitFor, forwardBusSubscribe, forwardBusUnsubscribe } from './ipc/bus.js';
import { getStorePath } from './ipc/store.js';
import {
  ensureAgentRuntimeBootstrap,
  addToRecentAgents,
} from './agent-manager.js';
import { runCleanup } from './cleanup.js';
import { scheduleBackup, stopBackupSchedulerForAgent } from './backup.js';
import type { AgentDbChange } from './db/sqlite.js';

export interface AppWindowContext {
  window: BrowserWindow;
  agentRoot: string;
  rendererBridge: RendererBridge;
  tabViewManager: TabViewManager;
  commandPalette: CommandPaletteManager;
  httpApi: HttpApiServer | null;
  triggerEngine: TriggerEngine | null;
  dbChangeDebounceTimer: ReturnType<typeof setTimeout> | null;
  triggerReloadDebounceTimer: ReturnType<typeof setTimeout> | null;
  tabTools: {
    getTabs: () => ReturnType<TabViewManager['getTabsHandler']>;
    openTab: (req: Parameters<TabViewManager['openTabHandler']>[0]) => ReturnType<TabViewManager['openTabHandler']>;
    closeTab: (req: Parameters<TabViewManager['closeTabHandler']>[0]) => ReturnType<TabViewManager['closeTabHandler']>;
    selectTab: (req: Parameters<TabViewManager['selectTabHandler']>[0]) => ReturnType<TabViewManager['selectTabHandler']>;
    reloadTab: (req: Parameters<TabViewManager['reloadTabHandler']>[0]) => ReturnType<TabViewManager['reloadTabHandler']>;
    captureTab: (req: Parameters<TabViewManager['captureTabById']>[0]) => ReturnType<TabViewManager['captureTabById']>;
    getTabConsoleLogs: (req: Parameters<TabViewManager['getTabConsoleLogsById']>[0]) => ReturnType<TabViewManager['getTabConsoleLogsById']>;
    execTabJs: (req: Parameters<TabViewManager['execTabJsById']>[0]) => ReturnType<TabViewManager['execTabJsById']>;
  };
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
}

class WindowManager {
  private windows = new Map<number, AppWindowContext>();
  private senderMap = new Map<number, number>(); // webContents.id → BrowserWindow.id
  private agentHashes = new Map<string, string>(); // hash → agentRoot
  private _onWindowCreated: (() => void) | null = null;

  set onWindowCreated(fn: (() => void) | null) {
    this._onWindowCreated = fn;
  }

  async createWindow(agentRoot: string): Promise<AppWindowContext> {
    await ensureAgentRuntimeBootstrap(agentRoot);
    addToRecentAgents(agentRoot);

    const window = new BrowserWindow({
      show: false,
      title: agentRoot,
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
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        webSecurity: false,
      },
    });

    const rendererBridge = new RendererBridge({
      getMainWindow: () => window,
    });

    const registerSender = (webContentsId: number) => {
      this.senderMap.set(webContentsId, window.id);
    };
    const unregisterSender = (webContentsId: number) => {
      this.senderMap.delete(webContentsId);
    };

    const commandPalette = new CommandPaletteManager({
      getMainWindow: () => window,
      getAgentRoot: () => agentRoot,
      rendererBridge,
      getTabViewManager: () => ctx.tabViewManager,
      getStorePath,
      registerSender,
      unregisterSender,
      openAgentInWindow: (root) => this.openAgentInWindow(root).then(() => {}),
    });

    const agentHash = this.getHashForAgentRoot(agentRoot);

    const tabViewManager = new TabViewManager({
      getMainWindow: () => window,
      toggleCommandPalette: () => commandPalette.toggle(),
      focusMainRendererWindow: () => rendererBridge.focusMainRendererWindow(),
      dispatchRendererCustomEvent: (name, detail) => rendererBridge.dispatchRendererCustomEvent(name, detail),
      dispatchRendererWindowEvent: (name) => rendererBridge.dispatchRendererWindowEvent(name),
      agentHash,
      registerSender,
      unregisterSender,
    });

    const ctx: AppWindowContext = {
      window,
      agentRoot,
      rendererBridge,
      tabViewManager,
      commandPalette,
      httpApi: null,
      triggerEngine: null,
      dbChangeDebounceTimer: null,
      triggerReloadDebounceTimer: null,
      tabTools: {
        getTabs: () => tabViewManager.getTabsHandler(),
        openTab: (req) => tabViewManager.openTabHandler(req),
        closeTab: (req) => tabViewManager.closeTabHandler(req),
        selectTab: (req) => tabViewManager.selectTabHandler(req),
        reloadTab: (req) => tabViewManager.reloadTabHandler(req),
        captureTab: (req) => tabViewManager.captureTabById(req),
        getTabConsoleLogs: (req) => tabViewManager.getTabConsoleLogsById(req),
        execTabJs: (req) => tabViewManager.execTabJsById(req),
      },
    };

    this.windows.set(window.id, ctx);
    this.senderMap.set(window.webContents.id, window.id);

    // Wire up window events
    window.on('page-title-updated', (evt) => {
      evt.preventDefault();
    });

    window.on('closed', () => {
      this.destroyWindow(window.id);
    });

    window.on('move', () => {
      commandPalette.syncBounds();
    });

    window.on('resize', () => {
      commandPalette.syncBounds();
    });

    window.maximize();

    window.webContents.on('did-start-loading', () => {
      commandPalette.destroy();
      tabViewManager.destroyAllTabViews();
    });

    window.loadURL('app://index.html');
    window.show();

    window.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      if (!key || input.alt || input.isAutoRepeat) return;

      const hasCommandModifier = process.platform === 'darwin' ? input.meta : input.control;
      if (!hasCommandModifier) return;

      if (!input.shift && key === 'k') {
        event.preventDefault();
        commandPalette.toggle();
        return;
      }
      if (!input.shift && key === 'i') {
        event.preventDefault();
        rendererBridge.dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
        return;
      }
      if (!input.shift && key === 'w') {
        event.preventDefault();
        rendererBridge.dispatchRendererWindowEvent('agentwfy:remove-current-tab');
        return;
      }
      if (!input.shift && key === 'r') {
        event.preventDefault();
        tabViewManager.reloadVisibleTabView();
      }
      if (input.shift && key === 'r') {
        event.preventDefault();
        window.reload();
      }
    });

    // Start HTTP API + triggers
    await this.startHttpServerForContext(ctx);

    if (ctx.triggerEngine) {
      window.webContents.once('did-finish-load', () => {
        ctx.triggerEngine?.start().catch(err => console.error('[triggers] Initial start failed:', err));
      });
    }

    // Schedule backup
    scheduleBackup(agentRoot).then(() => {
      rendererBridge.dispatchRendererWindowEvent('agentwfy:backup-changed');
    }).catch((err) => console.error('[backup] Schedule failed:', err));

    // Cleanup
    runCleanup(agentRoot).catch((err) => console.error('[cleanup] failed:', err));

    this._onWindowCreated?.();

    return ctx;
  }

  destroyWindow(windowId: number): void {
    const ctx = this.windows.get(windowId);
    if (!ctx) return;

    // Clear debounce timers
    if (ctx.dbChangeDebounceTimer) {
      clearTimeout(ctx.dbChangeDebounceTimer);
      ctx.dbChangeDebounceTimer = null;
    }

    ctx.commandPalette.destroy();
    ctx.tabViewManager.destroyAllTabViews();
    ctx.tabViewManager.clearTrackedViewWebContents();
    this.stopHttpServerForContext(ctx);
    stopBackupSchedulerForAgent(ctx.agentRoot);

    // Clean up sender map entries
    for (const [senderId, winId] of this.senderMap) {
      if (winId === windowId) {
        this.senderMap.delete(senderId);
      }
    }

    // Clean up agent hash if no other window uses this agent
    const agentStillOpen = Array.from(this.windows.values()).some(
      (other) => other !== ctx && other.agentRoot === ctx.agentRoot,
    );
    if (!agentStillOpen) {
      for (const [hash, root] of this.agentHashes) {
        if (root === ctx.agentRoot) {
          this.agentHashes.delete(hash);
          break;
        }
      }
    }

    this.windows.delete(windowId);
  }

  findWindowForAgent(agentRoot: string): AppWindowContext | null {
    for (const ctx of this.windows.values()) {
      if (ctx.agentRoot === agentRoot) return ctx;
    }
    return null;
  }

  // --- IPC routing ---

  getContextForSender(senderId: number): AppWindowContext {
    // Check explicit map first
    const windowId = this.senderMap.get(senderId);
    if (windowId !== undefined) {
      const ctx = this.windows.get(windowId);
      if (ctx) return ctx;
    }

    // Try to find via Electron's BrowserWindow API
    for (const ctx of this.windows.values()) {
      if (ctx.window.isDestroyed()) continue;
      if (ctx.window.webContents.id === senderId) {
        this.senderMap.set(senderId, ctx.window.id);
        return ctx;
      }
    }

    throw new Error(`No window context found for sender ${senderId}`);
  }

  tryGetContextForSender(senderId: number): AppWindowContext | null {
    try {
      return this.getContextForSender(senderId);
    } catch {
      return null;
    }
  }

  getAgentRootForEvent(event: IpcMainInvokeEvent): string {
    return this.getContextForSender(event.sender.id).agentRoot;
  }

  getWindowForEvent(event: IpcMainInvokeEvent): BrowserWindow {
    return this.getContextForSender(event.sender.id).window;
  }

  // --- Sender registration ---

  registerSender(webContentsId: number, windowId: number): void {
    this.senderMap.set(webContentsId, windowId);
  }

  unregisterSender(webContentsId: number): void {
    this.senderMap.delete(webContentsId);
  }

  // --- Protocol support ---

  getAgentRootForHash(hash: string): string | null {
    return this.agentHashes.get(hash) ?? null;
  }

  getHashForAgentRoot(agentRoot: string): string {
    // Reverse lookup: small map, O(N) is fine for typical window counts
    for (const [hash, root] of this.agentHashes) {
      if (root === agentRoot) return hash;
    }

    let hash = shortHash(agentRoot);

    // Handle collision: extend hash until unique
    const fullHex = crypto.createHash('sha256').update(agentRoot).digest('hex');
    let len = 10;
    while (this.agentHashes.has(hash) && this.agentHashes.get(hash) !== agentRoot) {
      len = Math.min(len + 4, fullHex.length);
      hash = fullHex.slice(0, len);
    }

    this.agentHashes.set(hash, agentRoot);
    return hash;
  }

  // --- DB change routing ---

  onDbChange(event: IpcMainInvokeEvent, change: AgentDbChange): void {
    const ctx = this.getContextForSender(event.sender.id);
    const { window: win, rendererBridge, triggerEngine } = ctx;

    if (win.isDestroyed()) return;
    win.webContents.send('bus:dbChanged', change);

    // Debounced reload of triggers when the triggers table changes
    if (change.table === 'triggers' && triggerEngine) {
      if (ctx.triggerReloadDebounceTimer) clearTimeout(ctx.triggerReloadDebounceTimer);
      ctx.triggerReloadDebounceTimer = setTimeout(() => {
        triggerEngine?.reload().catch(err => {
          console.error('[triggers] Reload failed:', err);
        });
      }, 500);
    }

    // Debounced backup status refresh
    if (ctx.dbChangeDebounceTimer) clearTimeout(ctx.dbChangeDebounceTimer);
    ctx.dbChangeDebounceTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      rendererBridge.dispatchRendererWindowEvent('agentwfy:backup-changed');
    }, 5000);
  }

  // --- HTTP server + triggers lifecycle ---

  private async startHttpServerForContext(ctx: AppWindowContext): Promise<void> {
    const { agentRoot, window: win } = ctx;
    cleanStaleLockfile(agentRoot);
    const preferredPort = readAgentHttpPort(agentRoot);

    try {
      ctx.httpApi = await startHttpApi({ getAgentRoot: () => agentRoot, preferredPort });
      writeLockfile(agentRoot, ctx.httpApi.port());
      ctx.triggerEngine = new TriggerEngine({
        getAgentRoot: () => agentRoot,
        startTask: (taskId, input?, origin?) => {
          if (win.isDestroyed()) throw new Error('Main window is not available');
          return forwardStartTask(win, taskId, input, origin);
        },
        busWaitFor: (topic, timeoutMs?) => {
          if (win.isDestroyed()) throw new Error('Main window is not available');
          return forwardBusWaitFor(win, topic, timeoutMs);
        },
        busSubscribe: (topic, fn) => {
          if (win.isDestroyed()) throw new Error('Main window is not available');
          const subId = forwardBusSubscribe(win, topic, fn);
          return () => {
            if (!win.isDestroyed()) {
              forwardBusUnsubscribe(win, subId);
            }
          };
        },
        httpApi: ctx.httpApi,
      });
    } catch (err) {
      console.error('[http-api] Failed to start HTTP server:', err);
    }
  }

  private stopHttpServerForContext(ctx: AppWindowContext): void {
    if (ctx.triggerEngine) {
      if (ctx.triggerReloadDebounceTimer) {
        clearTimeout(ctx.triggerReloadDebounceTimer);
        ctx.triggerReloadDebounceTimer = null;
      }
      ctx.triggerEngine.stop();
      ctx.triggerEngine = null;
    }
    if (ctx.httpApi) {
      ctx.httpApi.close().catch(err => console.error('[http-api] Close error:', err));
      ctx.httpApi = null;
    }
    removeLockfile(ctx.agentRoot);
  }

  // --- Lifecycle ---

  destroyAll(): void {
    // Copy IDs to avoid mutation during iteration (destroyWindow deletes from map)
    const windowIds = Array.from(this.windows.keys());
    for (const id of windowIds) {
      this.destroyWindow(id);
    }
  }

  getAllContexts(): AppWindowContext[] {
    return Array.from(this.windows.values());
  }

  get windowCount(): number {
    return this.windows.size;
  }

  // --- Open agent in window (focus existing or create new) ---

  async openAgentInWindow(agentRoot: string): Promise<AppWindowContext> {
    const existing = this.findWindowForAgent(agentRoot);
    if (existing) {
      if (!existing.window.isDestroyed()) {
        existing.window.focus();
        return existing;
      }
      // Window is destroyed but context lingers — clean it up
      this.destroyWindow(existing.window.id);
    }
    return this.createWindow(agentRoot);
  }

  // --- Broadcast to all windows ---

  broadcastSettingChanged(key: string, value: unknown): void {
    for (const ctx of this.windows.values()) {
      const cpWindow = ctx.commandPalette.getWindow();
      if (cpWindow && !cpWindow.isDestroyed()) {
        cpWindow.webContents.send(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, { key, value });
      }
    }
  }
}

export const windowManager = new WindowManager();
