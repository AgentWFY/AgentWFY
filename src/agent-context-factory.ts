import { session } from 'electron';
import type { BaseWindow, WebContentsView } from 'electron';
import { TabViewManager } from './tab-views/manager.js';
import { getConfigValue, setAgentConfig } from './settings/config.js';
import { ShortcutManager } from './shortcuts/manager.js';
import { createOpenAICompatibleFactory } from './providers/openai_compatible.js';
import { TriggerEngine } from './triggers/engine.js';
import { EventBus } from './event-bus.js';
import { AgentSessionManager } from './agent/session_manager.js';
import { TaskRunner } from './task-runner/task_runner.js';
import { getOrCreateRuntime, disposeRuntime } from './ipc/exec-js.js';
import type { AgentTabTools } from './ipc/tabs.js';
import { ensureAgentRuntimeBootstrap } from './agent-manager.js';
import { stopBackupSchedulerForAgent } from './backup.js';
import type { AgentDbChange } from './db/sqlite.js';
import { closeAgentDb, getOrCreateAgentDb } from './db/agent-db.js';
import { loadPlugins } from './plugins/loader.js';
import { ProviderRegistry } from './providers/registry.js';
import { SystemConfigKeys } from './system-config/keys.js';
import { FunctionRegistry } from './runtime/function_registry.js';
import { registerAllBuiltInFunctions } from './runtime/functions/index.js';
import { Channels } from './ipc/channels.cjs';
import type { SendToRenderer } from './ipc/schema.js';
import { createViewProtocolHandler } from './protocol/view-handler.js';
import type { AgentContext } from './agent-context.js';
import type { CommandPaletteManager } from './command-palette/manager.js';

export interface AgentContextFactoryDeps {
  getMainWindow: () => BaseWindow | null;
  getRendererWebContents: () => Electron.WebContents | null;
  sendToRenderer: SendToRenderer;
  focusMainRendererWindow: () => void;
  getCommandPalette: () => CommandPaletteManager;
  handleShortcutAction: (action: string) => void;
  getActiveAgentRoot: () => string | null;
  registerTabSender: (webContentsId: number, agentRoot: string) => void;
  unregisterTabSender: (webContentsId: number) => void;
  onRuntimeDbChange: (agentRoot: string, change: AgentDbChange) => void;
  clientPath: string;
  getOverlayViews?: () => ReadonlyArray<WebContentsView>;
}

export class AgentContextFactory {
  private agentSessions = new Map<string, Electron.Session>();
  private readonly deps: AgentContextFactoryDeps;

  constructor(deps: AgentContextFactoryDeps) {
    this.deps = deps;
  }

  async createContext(agentRoot: string): Promise<AgentContext> {
    const win = this.deps.getMainWindow()!;

    await ensureAgentRuntimeBootstrap(agentRoot);

    const db = getOrCreateAgentDb(agentRoot);
    db.setChangeListener((change) => this.deps.onRuntimeDbChange(agentRoot, change));

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

    const registerSender = (webContentsId: number) => this.deps.registerTabSender(webContentsId, agentRoot);
    const unregisterSender = (webContentsId: number) => this.deps.unregisterTabSender(webContentsId);

    const tabViewManager = new TabViewManager({
      getMainWindow: this.deps.getMainWindow,
      sendToRenderer: this.deps.sendToRenderer,
      focusMainRendererWindow: this.deps.focusMainRendererWindow,
      matchShortcut: (key, meta, ctrl, shift, alt) => {
        return agentCtx.shortcutManager.match(key, meta, ctrl, shift, alt);
      },
      handleAction: this.deps.handleShortcutAction,
      session: agentSession,
      registerSender,
      unregisterSender,
      getOverlayViews: this.deps.getOverlayViews,
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
      sendInput: (req: Parameters<TabViewManager['sendInputById']>[0]) => tabViewManager.sendInputById(req),
      inspectElement: (req: Parameters<TabViewManager['inspectElementById']>[0]) => tabViewManager.inspectElementById(req),
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

    registerAllBuiltInFunctions(functionRegistry, {
      agentRoot,
      rendererWebContents: this.deps.getRendererWebContents()!,
      tabTools,
      getSessionManager: () => agentCtx.sessionManager,
      getTaskRunner: () => agentCtx.taskRunner,
      getCommandPalette: () => this.deps.getCommandPalette(),
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
        if (!win.isDestroyed() && this.deps.getActiveAgentRoot() === agentRoot) {
          this.deps.sendToRenderer(Channels.tasks.runFinished, payload);
        }
      },
      onRunStarted: (payload) => {
        if (!win.isDestroyed() && this.deps.getActiveAgentRoot() === agentRoot) {
          this.deps.sendToRenderer(Channels.tasks.runStarted, payload);
        }
      },
    });

    const shortcutManager = new ShortcutManager(agentRoot);

    const triggerEngine = new TriggerEngine({
      getAgentRoot: () => agentRoot,
      getPreferredPort: () => Number(getConfigValue(agentRoot, SystemConfigKeys.httpApiPort, '9877')),
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

    return agentCtx;
  }

  destroyContext(agentRoot: string, ctx: AgentContext): void {
    ctx.agentStateStreamingCleanup?.();
    ctx.agentStateStreamingCleanup = null;
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

    ctx.pluginRegistry?.deactivateAll();
    ctx.tabViewManager.destroyAllTabViews();
    ctx.tabViewManager.clearTrackedViewWebContents();
    ctx.triggerEngine.stop();

    stopBackupSchedulerForAgent(agentRoot);
    disposeRuntime(agentRoot);
    closeAgentDb(agentRoot);

    const agentSession = this.agentSessions.get(agentRoot);
    if (agentSession) {
      agentSession.protocol.unhandle('agentview');
      this.agentSessions.delete(agentRoot);
    }
  }

  private getOrCreateAgentSession(agentRoot: string): Electron.Session {
    let agentSession = this.agentSessions.get(agentRoot);
    if (agentSession) return agentSession;

    agentSession = session.fromPartition(`agent:${agentRoot}`);

    const handler = createViewProtocolHandler({
      agentRoot,
      clientPath: this.deps.clientPath,
    });
    agentSession.protocol.handle('agentview', handler);

    this.agentSessions.set(agentRoot, agentSession);
    return agentSession;
  }
}
