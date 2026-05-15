// Shared bootstrap for a local-in-process agent runtime. Used by both the
// Electron desktop (via AgentContextFactory.createLocal) and the
// remote-backend-server daemon (via createAgentRuntime). The shared body
// wires up DB, plugins, providers, functions, sessions, tasks, triggers,
// and the LocalBackend. Callers provide host bundles for environment-bound
// surfaces (tabs, palette, notifications, renderer push, external launcher)
// and side-effect callbacks (DB change, task run started/finished).

import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { LocalBackend } from '../backend/local.js'
import { AgentSessionManager } from './session_manager.js'
import { EventBus } from '../event-bus.js'
import { FunctionRegistry } from '../runtime/function_registry.js'
import { JsRuntime } from '../runtime/js_runtime.js'
import { TraceWriter } from '../runtime/trace_writer.js'
import { registerAllBuiltInFunctions } from '../runtime/functions/index.js'
import type {
  ExternalLauncher,
  NotificationHost,
  PaletteHost,
  RendererPush,
  TabHost,
} from '../runtime/hosts.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createOpenAICompatibleFactory } from '../providers/openai_compatible.js'
import {
  TaskRunner,
  type TaskRunFinishedPayload,
  type TaskRunStartedPayload,
} from '../task-runner/task_runner.js'
import { TriggerEngine } from '../triggers/engine.js'
import { loadPlugins } from '../plugins/loader.js'
import type { PluginRegistry } from '../plugins/registry.js'
import { closeAgentDb, getOrCreateAgentDb } from '../db/agent-db.js'
import type { AgentDbChange } from '../db/sqlite.js'
import { ensureViewsSchema } from '../db/views.js'
import { getConfigValue, setAgentConfig } from '../settings/config.js'
import { SystemConfigKeys } from '../system-config/keys.js'

const AGENT_DIR_NAME = '.agentwfy'
const TRACES_DIR_NAME = '.agentwfy/traces'

export interface LocalRuntimeHosts {
  notificationHost?: NotificationHost
  tabTools?: TabHost
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
  createJsRuntime?: (functionRegistry: FunctionRegistry) => JsRuntime
  /** Single agent-DB change listener — only one can be registered on the DB
   *  itself, so callers fan out from here if they need multiple subscribers. */
  onDbChange?: (change: AgentDbChange) => void
  /** Extra side effect when a task run starts (the bus topic fires either way). */
  onTaskRunStarted?: (payload: TaskRunStartedPayload) => void
  /** Extra side effect when a task run finishes. */
  onTaskRunFinished?: (payload: TaskRunFinishedPayload) => void
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

  const jsRuntime = opts.createJsRuntime
    ? opts.createJsRuntime(functionRegistry)
    : new JsRuntime({
        functionRegistry,
        traceWriter: new TraceWriter(path.join(runtimeRoot, TRACES_DIR_NAME)),
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
    onRunStarted: (payload) => {
      busPublish('tasks.run.started', payload)
      opts.onTaskRunStarted?.(payload)
    },
    onRunFinished: (payload) => {
      busPublish('tasks.run.finished', payload)
      opts.onTaskRunFinished?.(payload)
    },
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
    ...(hosts?.tabTools ? { tabTools: hosts.tabTools } : {}),
    ...(hosts?.getCommandPalette ? { getCommandPalette: hosts.getCommandPalette } : {}),
    ...(hosts?.rendererPush ? { rendererPush: hosts.rendererPush } : {}),
    ...(hosts?.externalLauncher ? { externalLauncher: hosts.externalLauncher } : {}),
  })

  const backend = new LocalBackend({
    agentId: runtimeRoot,
    runtimeRoot: runtimeRoot,
    eventBus,
    sessionManager,
    functionRegistry,
    providerRegistry,
    taskRunner,
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
    dispose,
  }
}
