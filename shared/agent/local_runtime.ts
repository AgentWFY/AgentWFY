// Shared bootstrap for a local-in-process agent runtime. Used by both the
// Electron desktop (via AgentContextFactory.createLocal) and the
// server daemon (via createAgentRuntime). The shared body
// wires up DB, plugins, providers, functions, sessions, tasks, triggers,
// and the LocalBackend. Callers provide host bundles for environment-bound
// surfaces (tabs, palette, notifications, renderer push, external launcher)
// and a DB-change listener.

import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { LocalBackend } from '../backend/local.js'
import { AgentSessionManager } from './session_manager.js'
import { EventBus } from '../event-bus.js'
import { FunctionRegistry } from '../runtime/function_registry.js'
import { JsRuntime } from '../runtime/js_runtime.js'
import { TraceWriter } from '../runtime/trace_writer.js'
import { getTraceDir } from '../runtime/trace_paths.js'
import { registerAllBuiltInFunctions } from '../runtime/functions/index.js'
import type {
  ExternalLauncher,
  NotificationHost,
  PaletteHost,
  RendererPush,
  TabApi,
} from '../runtime/hosts.js'
import type { PageApi, PageOwnerHostKind } from '../page/types.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createOpenAICompatibleFactory } from '../providers/openai_compatible.js'
import { TaskRunner } from '../task-runner/task_runner.js'
import { TriggerEngine } from '../triggers/engine.js'
import { loadPlugins } from '../plugins/loader.js'
import type { PluginRegistry } from '../plugins/registry.js'
import { closeAgentDb, getOrCreateAgentDb } from '../db/agent-db.js'
import type { AgentDbChange } from '../db/sqlite.js'
import { ensureViewsSchema } from '../db/views.js'
import { getConfigValue, setAgentConfig } from '../settings/config.js'
import { SystemConfigKeys } from '../system-config/keys.js'

const AGENT_DIR_NAME = '.agentwfy'

export interface LocalRuntimeHosts {
  notificationHost?: NotificationHost
  pageTools?: PageApi
  tabTools?: TabApi
  legacyPageHostKind?: PageOwnerHostKind
  legacyHeadlessPageHostKind?: PageOwnerHostKind
  getCommandPalette?: () => PaletteHost
  rendererPush?: RendererPush
  externalLauncher?: ExternalLauncher
}

export interface CreateLocalAgentRuntimeOptions {
  runtimeRoot: string
  hosts?: LocalRuntimeHosts
  /** Build the JsRuntime for this agent. Defaults to a fresh JsRuntime with
   *  a per-agent TraceWriter. The desktop overrides this to thread the
   *  runtime through its lifecycle-managed registry. */
  createJsRuntime?: (functionRegistry: FunctionRegistry, traceWriter: TraceWriter) => JsRuntime
  /** Build the TraceWriter for this agent. Defaults to `getTraceDir(runtimeRoot)`. */
  createTraceWriter?: (runtimeRoot: string) => TraceWriter
  /** Single agent-DB change listener — only one can be registered on the DB
   *  itself, so callers fan out from here if they need multiple subscribers. */
  onDbChange?: (change: AgentDbChange) => void
}

export interface LocalAgentRuntime {
  backend: LocalBackend
  eventBus: EventBus
  providerRegistry: ProviderRegistry
  functionRegistry: FunctionRegistry
  pluginRegistry: PluginRegistry | null
  sessionManager: AgentSessionManager
  taskRunner: TaskRunner
  triggerEngine: TriggerEngine
  jsRuntime: JsRuntime
  traceWriter: TraceWriter
  /** Teardown the core runtime (backend, sessions, tasks, triggers, plugins,
   *  event bus, DB). Does NOT dispose the JsRuntime — that's the caller's
   *  responsibility because the desktop and daemon manage it differently. */
  dispose: () => Promise<void>
}

export async function createLocalAgentRuntime(
  opts: CreateLocalAgentRuntimeOptions,
): Promise<LocalAgentRuntime> {
  const { runtimeRoot, hosts } = opts

  await mkdir(path.join(runtimeRoot, AGENT_DIR_NAME), { recursive: true })
  await ensureViewsSchema(runtimeRoot)

  const db = getOrCreateAgentDb(runtimeRoot)
  if (opts.onDbChange) db.setChangeListener(opts.onDbChange)

  const providerRegistry = new ProviderRegistry()
  providerRegistry.register(createOpenAICompatibleFactory({
    getConfig: (key, fallback) => getConfigValue(runtimeRoot, key, fallback),
    setConfig: (key, value) => setAgentConfig(runtimeRoot, key, value),
  }))

  const functionRegistry = new FunctionRegistry()
  const eventBus = new EventBus()
  const busPublish = (topic: string, data: unknown) => eventBus.publish(topic, data)

  const pluginRegistry = loadPlugins(runtimeRoot, busPublish, providerRegistry, functionRegistry)

  const traceWriter = opts.createTraceWriter
    ? opts.createTraceWriter(runtimeRoot)
    : new TraceWriter(getTraceDir(runtimeRoot))

  const jsRuntime = opts.createJsRuntime
    ? opts.createJsRuntime(functionRegistry, traceWriter)
    : new JsRuntime({
        functionRegistry,
        traceWriter,
      })

  const sessionManager = new AgentSessionManager({
    runtimeRoot,
    providerRegistry,
    getJsRuntime: () => jsRuntime,
    busPublish,
    ...(hosts?.notificationHost ? { notificationHost: hosts.notificationHost } : {}),
  })

  const taskRunner = new TaskRunner({
    runtimeRoot,
    getJsRuntime: () => jsRuntime,
    busPublish,
  })

  const triggerEngine = new TriggerEngine({
    getRuntimeRoot: () => runtimeRoot,
    getPreferredPort: () => Number(getConfigValue(runtimeRoot, SystemConfigKeys.httpApiPort, '9877')),
    startTask: async (taskName, input, origin) => {
      const runId = await taskRunner.startTask(
        taskName,
        input,
        origin as Parameters<typeof taskRunner.startTask>[2],
      )
      return { runId }
    },
    waitFor: (topic, timeoutMs) => eventBus.waitFor(topic, timeoutMs),
    busSubscribe: (topic, fn) => eventBus.subscribe(topic, fn),
    busPublish,
  })

  registerAllBuiltInFunctions(functionRegistry, {
    runtimeRoot,
    getSessionManager: () => sessionManager,
    getTaskRunner: () => taskRunner,
    eventBus,
    providerRegistry,
    ...(hosts?.pageTools ? { pageTools: hosts.pageTools } : {}),
    ...(hosts?.tabTools ? { tabTools: hosts.tabTools } : {}),
    ...(hosts?.legacyPageHostKind ? { legacyPageHostKind: hosts.legacyPageHostKind } : {}),
    ...(hosts?.legacyHeadlessPageHostKind ? { legacyHeadlessPageHostKind: hosts.legacyHeadlessPageHostKind } : {}),
    ...(hosts?.getCommandPalette ? { getCommandPalette: hosts.getCommandPalette } : {}),
    ...(hosts?.rendererPush ? { rendererPush: hosts.rendererPush } : {}),
    ...(hosts?.externalLauncher ? { externalLauncher: hosts.externalLauncher } : {}),
  })

  const backend = new LocalBackend({
    agentId: runtimeRoot,
    runtimeRoot: runtimeRoot,
    sessionManager,
    functionRegistry,
    providerRegistry,
    taskRunner,
    traceWriter,
  })
  await backend.start()

  const dispose = async (): Promise<void> => {
    await backend.stop().catch((err) => console.warn('[local-runtime] backend.stop:', err))
    triggerEngine.stop()
    pluginRegistry?.deactivateAll()
    taskRunner.dispose()
    await sessionManager.disposeAll().catch((err) => console.warn('[local-runtime] disposeAll:', err))
    eventBus.dispose()
    closeAgentDb(runtimeRoot)
  }

  return {
    backend,
    eventBus,
    providerRegistry,
    functionRegistry,
    pluginRegistry,
    sessionManager,
    taskRunner,
    triggerEngine,
    jsRuntime,
    traceWriter,
    dispose,
  }
}
