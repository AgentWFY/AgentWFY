import { app, session } from 'electron';
import type { BaseWindow, WebContentsView } from 'electron';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  createElectronRendererPush,
  getElectronExternalLauncher,
  getElectronNotificationHost,
} from './runtime/hosts-electron.js';
import { TabViewManager } from './tab-views/manager.js';
import { ShortcutManager } from './shortcuts/manager.js';
import type { ActionRegistry } from './shortcuts/registry.js';
import { syncTaskActions } from './shortcuts/task-actions.js';
import { getOrCreateRuntime, disposeRuntime } from './ipc/exec-js.js';
import type { TabHost } from '#shared/runtime/hosts.js';
import { stopBackupSchedulerForAgent } from './backup.js';
import type { AgentDbChange } from '#shared/db/sqlite.js';
import { closeAgentDb, configureAgentDb } from '#shared/db/agent-db.js';
import { Channels } from './ipc/channels.cjs';
import type { SendToRenderer } from './ipc/schema.js';
import { createViewProtocolHandler } from './protocol/view-handler.js';
import type { AgentContext, LocalAgentContext, RemoteAgentContext } from './agent-context.js';
import type { CommandPaletteManager } from './command-palette/manager.js';
import { createLocalAgentRuntime } from '#shared/agent/local_runtime.js';
import { LocalChatController } from './chat/local_chat_controller.js';
import { getAgentMeta } from './agent-meta.js';
import { createRemoteAgentContext, destroyRemoteAgentContext } from './agent-context-remote.js';

export interface AgentContextFactoryDeps {
  getMainWindow: () => BaseWindow | null;
  getRendererWebContents: () => Electron.WebContents | null;
  sendToRenderer: SendToRenderer;
  focusMainRendererWindow: () => void;
  getCommandPalette: () => CommandPaletteManager;
  handleShortcutAction: (action: string) => void;
  getActiveAgentId: () => string | null;
  registerTabSender: (webContentsId: number, agentId: string) => void;
  unregisterTabSender: (webContentsId: number) => void;
  onRuntimeDbChange: (agentId: string, change: AgentDbChange) => void;
  clientPath: string;
  getOverlayViews?: () => ReadonlyArray<WebContentsView>;
  actionRegistry: ActionRegistry;
}

export class AgentContextFactory {
  private agentSessions = new Map<string, Electron.Session>();
  private readonly deps: AgentContextFactoryDeps;

  constructor(deps: AgentContextFactoryDeps) {
    this.deps = deps;
  }

  async createContext(agentId: string): Promise<AgentContext> {
    const meta = getAgentMeta(agentId);
    if (meta.backend === 'remote') {
      if (!meta.remoteConfig) {
        throw new Error(`Agent ${agentId} is marked remote but has no remoteConfig`);
      }
      return this.createRemote(agentId, meta.remoteConfig);
    }
    return this.createLocal(agentId);
  }

  private async createRemote(
    agentId: string,
    remoteConfig: { baseUrl: string; agentToken: string },
  ): Promise<RemoteAgentContext> {
    const cacheRoot = this.computeRemoteCacheRoot(agentId);
    fs.mkdirSync(path.join(cacheRoot, '.agentwfy'), { recursive: true });
    configureAgentDb(cacheRoot, { syncSystemData: false });
    const shortcutManager = new ShortcutManager(cacheRoot, this.deps.actionRegistry, { readConfig: false });
    const { tabViewManager, tabTools } = this.createTabRuntime(agentId, cacheRoot, shortcutManager);
    return createRemoteAgentContext({
      agentId,
      cacheRoot,
      remoteConfig,
      shortcutManager,
      tabViewManager,
      tabTools,
      getCommandPalette: () => this.deps.getCommandPalette(),
      onLocalDbChange: (change) => this.deps.onRuntimeDbChange(agentId, change),
    });
  }

  private async createLocal(agentId: string): Promise<LocalAgentContext> {
    const win = this.deps.getMainWindow()!;

    // Desktop-only surfaces are built up-front because the shared runtime
    // needs the tab/palette/renderer/external hosts during builtin-function
    // registration.
    const agentSession = this.getOrCreateAgentSession(agentId, agentId);
    const registerSender = (webContentsId: number) => this.deps.registerTabSender(webContentsId, agentId);
    const unregisterSender = (webContentsId: number) => this.deps.unregisterTabSender(webContentsId);

    let agentCtxRef: LocalAgentContext | null = null;
    const tabViewManager = new TabViewManager({
      getMainWindow: this.deps.getMainWindow,
      sendToRenderer: this.deps.sendToRenderer,
      focusMainRendererWindow: this.deps.focusMainRendererWindow,
      matchShortcut: (key, meta, ctrl, shift, alt) => {
        return agentCtxRef?.shortcutManager.match(key, meta, ctrl, shift, alt) ?? null;
      },
      handleAction: this.deps.handleShortcutAction,
      session: agentSession,
      registerSender,
      unregisterSender,
      getOverlayViews: this.deps.getOverlayViews,
    });
    const tabTools: TabHost = buildTabTools(tabViewManager);

    const runtime = await createLocalAgentRuntime({
      runtimeRoot: agentId,
      hosts: {
        notificationHost: getElectronNotificationHost(),
        tabTools,
        getCommandPalette: () => this.deps.getCommandPalette(),
        rendererPush: createElectronRendererPush(this.deps.getRendererWebContents()!),
        externalLauncher: getElectronExternalLauncher(),
      },
      createJsRuntime: (functionRegistry) => getOrCreateRuntime(agentId, { functionRegistry }),
      onDbChange: (change) => this.deps.onRuntimeDbChange(agentId, change),
      onTaskRunStarted: (payload) => {
        if (!win.isDestroyed() && this.deps.getActiveAgentId() === agentId) {
          this.deps.sendToRenderer(Channels.tasks.runStarted, payload);
        }
      },
      onTaskRunFinished: (payload) => {
        if (!win.isDestroyed() && this.deps.getActiveAgentId() === agentId) {
          this.deps.sendToRenderer(Channels.tasks.runFinished, payload);
        }
      },
    });

    syncTaskActions(this.deps.actionRegistry, agentId, runtime.taskRunner);
    const shortcutManager = new ShortcutManager(agentId, this.deps.actionRegistry);

    const agentCtx: LocalAgentContext = {
      mode: 'local',
      agentId: agentId,
      runtimeRoot: agentId,
      cacheRoot: agentId,
      eventBus: runtime.eventBus,
      tabViewManager,
      triggerEngine: runtime.triggerEngine,
      pluginRegistry: runtime.pluginRegistry,
      providerRegistry: runtime.providerRegistry,
      functionRegistry: runtime.functionRegistry,
      sessionManager: runtime.sessionManager,
      taskRunner: runtime.taskRunner,
      jsRuntime: runtime.jsRuntime,
      shortcutManager,
      backend: runtime.backend,
      chat: new LocalChatController(runtime.sessionManager),
      chatPump: null,
      dbChangeDebounceTimer: null,
      triggerReloadDebounceTimer: null,
      taskActionsReloadDebounceTimer: null,
      tabTools,
    };
    agentCtxRef = agentCtx;

    return agentCtx;
  }

  destroyContext(agentId: string, ctx: AgentContext): void {
    if (ctx.mode === 'remote') {
      ctx.chatPump?.stop();
      ctx.chatPump = null;
      ctx.statusUnsubscribe?.();
      ctx.statusUnsubscribe = null;
      ctx.tabViewManager.destroyAllTabViews();
      ctx.tabViewManager.clearTrackedViewWebContents();
      destroyRemoteAgentContext(ctx).catch((err) => {
        console.warn('[AgentContextFactory] destroyRemoteAgentContext failed:', err);
      });
      closeAgentDb(ctx.cacheRoot);
      const agentSession = this.agentSessions.get(ctx.agentId);
      if (agentSession) {
        agentSession.protocol.unhandle('agentview');
        this.agentSessions.delete(ctx.agentId);
      }
      return;
    }

    ctx.chatPump?.stop();
    ctx.chatPump = null;
    ctx.backend.stop().catch((err) => {
      console.warn('[AgentContextFactory] backend.stop failed:', err);
    });
    ctx.sessionManager.disposeAll().catch((err) => {
      console.warn('[AgentContextFactory] disposeAll failed:', err);
    });
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
    if (ctx.taskActionsReloadDebounceTimer) {
      clearTimeout(ctx.taskActionsReloadDebounceTimer);
      ctx.taskActionsReloadDebounceTimer = null;
    }

    ctx.pluginRegistry?.deactivateAll();
    ctx.tabViewManager.destroyAllTabViews();
    ctx.tabViewManager.clearTrackedViewWebContents();
    ctx.triggerEngine.stop();

    this.deps.actionRegistry.clearAgent(agentId);

    stopBackupSchedulerForAgent(agentId);
    disposeRuntime(agentId);
    closeAgentDb(agentId);

    const agentSession = this.agentSessions.get(agentId);
    if (agentSession) {
      agentSession.protocol.unhandle('agentview');
      this.agentSessions.delete(agentId);
    }
  }

  private getOrCreateAgentSession(agentId: string, cacheRoot: string): Electron.Session {
    let agentSession = this.agentSessions.get(agentId);
    if (agentSession) return agentSession;

    agentSession = session.fromPartition(`agent:${agentId}`);

    const handler = createViewProtocolHandler({
      cacheRoot,
      clientPath: this.deps.clientPath,
    });
    agentSession.protocol.handle('agentview', handler);

    this.agentSessions.set(agentId, agentSession);
    return agentSession;
  }

  private computeRemoteCacheRoot(agentId: string): string {
    const hash = createHash('sha256').update(agentId).digest('hex').slice(0, 16);
    return path.join(app.getPath('userData'), 'remote-agents', hash);
  }

  private createTabRuntime(
    ownerAgentId: string,
    cacheRoot: string,
    shortcutManager: ShortcutManager,
  ): { tabViewManager: TabViewManager; tabTools: TabHost } {
    const agentSession = this.getOrCreateAgentSession(ownerAgentId, cacheRoot);
    const registerSender = (webContentsId: number) => this.deps.registerTabSender(webContentsId, ownerAgentId);
    const unregisterSender = (webContentsId: number) => this.deps.unregisterTabSender(webContentsId);

    const tabViewManager = new TabViewManager({
      getMainWindow: this.deps.getMainWindow,
      sendToRenderer: this.deps.sendToRenderer,
      focusMainRendererWindow: this.deps.focusMainRendererWindow,
      matchShortcut: (key, meta, ctrl, shift, alt) => {
        return shortcutManager.match(key, meta, ctrl, shift, alt);
      },
      handleAction: this.deps.handleShortcutAction,
      session: agentSession,
      registerSender,
      unregisterSender,
      getOverlayViews: this.deps.getOverlayViews,
    });

    const tabTools: TabHost = buildTabTools(tabViewManager);

    return { tabViewManager, tabTools };
  }
}

function buildTabTools(tabViewManager: TabViewManager): TabHost {
  return {
    getTabs: () => tabViewManager.getTabsHandler(),
    openTab: (req) => tabViewManager.openTabHandler(req),
    closeTab: (req) => tabViewManager.closeTabHandler(req),
    selectTab: (req) => tabViewManager.selectTabHandler(req),
    reloadTab: (req) => tabViewManager.reloadTabHandler(req),
    captureTab: (req) => tabViewManager.captureTabById(req),
    getTabConsoleLogs: (req) => tabViewManager.getTabConsoleLogsById(req),
    execTabJs: (req) => tabViewManager.execTabJsById(req),
    sendInput: (req) => tabViewManager.sendInputById(req),
    inspectElement: (req) => tabViewManager.inspectElementById(req),
    tabDebuggerSend: (req) => tabViewManager.tabDebuggerSendById(req),
    tabDebuggerSubscribe: async (req) => {
      tabViewManager.tabDebuggerSubscribeById(req);
    },
    tabDebuggerPoll: (req) => tabViewManager.tabDebuggerPollById(req),
    tabDebuggerUnsubscribe: async (req) => {
      tabViewManager.tabDebuggerUnsubscribeById(req.subscriptionId);
    },
    tabDebuggerDetach: async (req) => {
      tabViewManager.tabDebuggerDetachById(req.tabId);
    },
  };
}
