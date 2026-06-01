import { net, session } from 'electron';
import type { BaseWindow, WebContentsView } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  createElectronRendererPush,
  getElectronExternalLauncher,
  getElectronNotificationHost,
} from './runtime/hosts-electron.js';
import { TabViewManager } from './tab-view-manager.js';
import { DesktopPageHost } from './page/desktop-page-host.js';
import { ElectronHeadlessPageHost } from './page/electron-headless-page-host.js';
import { ShortcutManager } from './shortcuts/manager.js';
import type { ActionRegistry } from './shortcuts/registry.js';
import { syncTaskActions } from './shortcuts/task-actions.js';
import {
  disposeDesktopRuntime,
  getOrCreateDesktopRuntime,
  getOrCreateDesktopTraceWriter,
} from './runtime/desktop-runtime-registry.js';
import type { PageApi } from '#shared/page/types.js';
import { PageManager } from '#shared/page/page-manager.js';
import type { AgentBackend } from '#shared/backend/interface.js';
import { stopBackupSchedulerForAgent } from '#shared/backup-scheduler.js';
import type { AgentDbChange } from '#shared/db/sqlite.js';
import { closeAgentDb, configureAgentDb } from '#shared/db/agent-db.js';
import type { SendToRenderer } from './ipc/schema.js';
import { createViewProtocolHandler } from './protocol/view-handler.js';
import { agentHostname } from './protocol/agent-hostname.js';
import { LocalFileSource, RemoteFileSource, type FileSource } from './protocol/file-source.js';
import type { AgentContext, LocalAgentContext, RemoteAgentContext } from './agent-context.js';
import type { CommandPaletteManager } from './command-palette/manager.js';
import { createLocalAgentRuntime } from '#shared/agent/local_runtime.js';
import { LocalChatController } from './chat/local_chat_controller.js';
import { getAgentMeta, getRemoteAgentCacheRoot } from './agent-meta.js';
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
    const cacheRoot = getRemoteAgentCacheRoot(agentId, remoteConfig);
    fs.mkdirSync(path.join(cacheRoot, '.agentwfy'), { recursive: true });
    configureAgentDb(cacheRoot, { syncSystemData: false });
    const shortcutManager = new ShortcutManager(agentId, this.deps.actionRegistry, { dataDir: cacheRoot });
    const { tabViewManager, pageTools } = this.createTabRuntime(agentId, shortcutManager);
    // Refs let onSnapshotApplied resync after later (re)connect snapshots,
    // which replace the mirror wholesale without emitting per-row changes.
    let backendRef: AgentBackend | null = null;
    const resyncFromMirror = () => {
      if (!backendRef) return;
      syncTaskActions(this.deps.actionRegistry, cacheRoot, backendRef);
      shortcutManager.reload();
    };
    const ctx = await createRemoteAgentContext({
      agentId,
      cacheRoot,
      remoteConfig,
      shortcutManager,
      tabViewManager,
      pageTools,
      getCommandPalette: () => this.deps.getCommandPalette(),
      isActiveForAgent: () => this.deps.getActiveAgentId() === agentId,
      onLocalDbChange: (change) => this.deps.onRuntimeDbChange(agentId, change),
      onSnapshotApplied: resyncFromMirror,
    });
    backendRef = ctx.backend;
    resyncFromMirror();
    this.attachAgentViewHandler(
      agentId,
      cacheRoot,
      new RemoteFileSource(ctx.backend, {
        agentId,
        daemonBaseUrl: remoteConfig.baseUrl,
        agentToken: remoteConfig.agentToken,
      }),
    );
    return ctx;
  }

  private async createLocal(agentId: string): Promise<LocalAgentContext> {
    // Desktop-only surfaces are built up-front because the shared runtime
    // needs the tab/palette/renderer/external hosts during builtin-function
    // registration.
    const agentSession = this.ensureAgentSession(agentId);
    this.attachAgentViewHandler(agentId, agentId, new LocalFileSource(agentId));
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
      agentId,
      session: agentSession,
      registerSender,
      unregisterSender,
      getOverlayViews: this.deps.getOverlayViews,
    });
    const pageTools: PageApi = buildLocalDesktopPageTools(agentId, tabViewManager);

    const runtime = await createLocalAgentRuntime({
      runtimeRoot: agentId,
      hosts: {
        notificationHost: getElectronNotificationHost(),
        pageTools,
        getCommandPalette: () => this.deps.getCommandPalette(),
        rendererPush: createElectronRendererPush(this.deps.getRendererWebContents()!),
        externalLauncher: getElectronExternalLauncher(),
      },
      createTraceWriter: () => getOrCreateDesktopTraceWriter(agentId),
      createJsRuntime: (functionRegistry, traceWriter) => getOrCreateDesktopRuntime(agentId, { functionRegistry, traceWriter }),
      onDbChange: (change) => this.deps.onRuntimeDbChange(agentId, change),
    });

    syncTaskActions(this.deps.actionRegistry, agentId, runtime.backend);
    const shortcutManager = new ShortcutManager(agentId, this.deps.actionRegistry);
    shortcutManager.reload();

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
      chat: new LocalChatController(() => agentCtx.sessionManager),
      chatPump: null,
      eventsUnsubscribe: null,
      dbChangeDebounceTimer: null,
      triggerReloadDebounceTimer: null,
      taskActionsReloadDebounceTimer: null,
      providerStatePushTimer: null,
      pageTools,
    };
    agentCtxRef = agentCtx;

    return agentCtx;
  }

  destroyContext(agentId: string, ctx: AgentContext): void {
    ctx.chatPump?.stop();
    ctx.chatPump = null;
    ctx.eventsUnsubscribe?.();
    ctx.eventsUnsubscribe = null;

    if (ctx.mode === 'remote') {
      ctx.statusUnsubscribe?.();
      ctx.statusUnsubscribe = null;
      if (ctx.taskActionsReloadDebounceTimer) {
        clearTimeout(ctx.taskActionsReloadDebounceTimer);
        ctx.taskActionsReloadDebounceTimer = null;
      }
      if (ctx.providerStatePushTimer) {
        clearTimeout(ctx.providerStatePushTimer);
        ctx.providerStatePushTimer = null;
      }
      ctx.tabViewManager.destroyAllTabViews();
      ctx.tabViewManager.clearTrackedViewWebContents();
      destroyRemoteAgentContext(ctx).catch((err) => {
        console.warn('[AgentContextFactory] destroyRemoteAgentContext failed:', err);
      });
      this.deps.actionRegistry.clearAgent(agentId);
      closeAgentDb(ctx.cacheRoot);
      const agentSession = this.agentSessions.get(ctx.agentId);
      if (agentSession) {
        agentSession.protocol.unhandle('https');
        this.agentSessions.delete(ctx.agentId);
      }
      return;
    }

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
    if (ctx.providerStatePushTimer) {
      clearTimeout(ctx.providerStatePushTimer);
      ctx.providerStatePushTimer = null;
    }

    ctx.pluginRegistry?.deactivateAll();
    ctx.tabViewManager.destroyAllTabViews();
    ctx.tabViewManager.clearTrackedViewWebContents();
    ctx.triggerEngine.stop();

    this.deps.actionRegistry.clearAgent(agentId);

    stopBackupSchedulerForAgent(agentId);
    disposeDesktopRuntime(agentId);
    closeAgentDb(agentId);

    const agentSession = this.agentSessions.get(agentId);
    if (agentSession) {
      agentSession.protocol.unhandle('https');
      this.agentSessions.delete(agentId);
    }
  }

  private ensureAgentSession(agentId: string): Electron.Session {
    let agentSession = this.agentSessions.get(agentId);
    if (agentSession) return agentSession;
    agentSession = session.fromPartition(`agent:${agentId}`);
    this.agentSessions.set(agentId, agentSession);
    return agentSession;
  }

  // Idempotent: re-attaching for the same agentId replaces the previous handler.
  // Intercepts https on the agent's session — requests whose hostname matches
  // the agent's pseudo-host get routed to the view handler; everything else
  // falls through to the real network via net.fetch.
  private attachAgentViewHandler(agentId: string, cacheRoot: string, fileSource: FileSource): void {
    const agentSession = this.agentSessions.get(agentId);
    if (!agentSession) {
      throw new Error(`No Electron session for agent ${agentId}; call ensureAgentSession first`);
    }
    if (agentSession.protocol.isProtocolHandled('https')) {
      agentSession.protocol.unhandle('https');
    }
    const viewHandler = createViewProtocolHandler({
      cacheRoot,
      clientPath: this.deps.clientPath,
      fileSource,
    });
    const ownHostname = agentHostname(agentId);
    agentSession.protocol.handle('https', (request) => {
      const url = new URL(request.url);
      if (url.hostname === ownHostname) {
        return viewHandler(request, url);
      }
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    });
  }

  private createTabRuntime(
    ownerAgentId: string,
    shortcutManager: ShortcutManager,
  ): { tabViewManager: TabViewManager; pageTools: PageApi } {
    const agentSession = this.ensureAgentSession(ownerAgentId);
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
      agentId: ownerAgentId,
      session: agentSession,
      registerSender,
      unregisterSender,
      getOverlayViews: this.deps.getOverlayViews,
    });

    const pageTools: PageApi = buildLocalDesktopPageTools(ownerAgentId, tabViewManager);

    return { tabViewManager, pageTools };
  }
}

function buildLocalDesktopPageTools(agentId: string, tabViewManager: TabViewManager): PageApi {
  return new PageManager({
    agentId,
    hosts: [
      new DesktopPageHost(tabViewManager, { agentId }),
      new ElectronHeadlessPageHost(tabViewManager, { agentId }),
    ],
  });
}
