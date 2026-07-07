// Host-neutral core of a local-in-process agent runtime. Any host that runs an
// agent in-process builds the same middle layer — provider registry, function
// registry, event bus, trace writer, JS runtime, session manager, task runner,
// the built-in functions, and a `LocalBackend` — over a small set of injected,
// host-specific resources:
//
//   - Node (`local_runtime.ts`): NodeFileStore, `child_process` JsRuntime,
//     fs-backed files/backup, and a plugin loader.
//
// Because every host-specific dependency is injected, an alternate backend can
// supply its own resources — a different file store, JsRuntime, and page tools —
// without touching this core.
//
// This factory owns only the shared construction (incl. `backend.start()`). The
// host-specific pieces — DB construction + registration, the trigger engine, the
// DB-change listener, and teardown ordering — stay with each host, which composes
// them around the returned core. The factory is free of node:* / Electron value
// imports (it takes the JsRuntime, file store, files, and backup as resources).

import { LocalBackend } from '../backend/local.js'
import { AgentSessionManager } from './session_manager.js'
import { EventBus } from '../event-bus.js'
import { FunctionRegistry } from '../runtime/function_registry.js'
import { TraceWriter } from '../runtime/trace_writer.js'
import { registerAllBuiltInFunctions } from '../runtime/functions/index.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createOpenAICompatibleFactory } from '../providers/openai_compatible.js'
import { TaskRunner } from '../task-runner/task_runner.js'
import { getConfigValue, setAgentConfig } from '../settings/config.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import type { FileStore } from '../storage/file-store.js'
import type { FilesApi, BackupApi } from '../backend/interface.js'
import type { PageApi } from '../page/types.js'
import type { ExternalLauncher, NotificationHost, PaletteHost, RendererPush } from '../runtime/hosts.js'

export interface AgentRuntimeResources {
  /** Identifier passed to `LocalBackend` (the agent id reported over the wire). */
  agentId: string
  /** Registry key + config/runSql scope. On Node this is the agent directory; a
   *  filesystem-less host can use any stable key (all file I/O goes through `store`). */
  runtimeRoot: string
  /** The agent's file tree (a `NodeFileStore` on Node). */
  store: FileStore
  /** Bytes-level agent file access for `LocalBackend` (files.read/stat). */
  files: FilesApi
  /** Per-agent DB backup API for `LocalBackend`. */
  backup: BackupApi
  /** Build the JsRuntime for this agent over the shared function registry +
   *  trace writer (a `child_process` `JsRuntime` on Node). */
  createJsRuntime: (functionRegistry: FunctionRegistry, traceWriter: TraceWriter) => JsRuntime
  /** Override the TraceWriter (the desktop threads it through a lifecycle
   *  registry). Defaults to one backed by `store`. */
  createTraceWriter?: (store: FileStore) => TraceWriter
  /** Hook run after the provider/function/event registries exist but before the
   *  built-in functions are registered. Node loads plugins here so plugin-
   *  registered providers/functions slot in ahead of the built-ins; hosts without
   *  plugins omit it. */
  loadExtras?: (deps: {
    runtimeRoot: string
    busPublish: (topic: string, data: unknown) => void
    providerRegistry: ProviderRegistry
    functionRegistry: FunctionRegistry
  }) => void
  // Optional host surfaces threaded into the session manager / built-in
  // functions. Present only where the host provides them (mostly desktop).
  notificationHost?: NotificationHost
  pageTools?: PageApi
  getCommandPalette?: () => PaletteHost
  rendererPush?: RendererPush
  externalLauncher?: ExternalLauncher
}

export interface AgentRuntimeCore {
  backend: LocalBackend
  providerRegistry: ProviderRegistry
  functionRegistry: FunctionRegistry
  eventBus: EventBus
  busPublish: (topic: string, data: unknown) => void
  traceWriter: TraceWriter
  jsRuntime: JsRuntime
  sessionManager: AgentSessionManager
  taskRunner: TaskRunner
}

/** Build the shared agent-runtime core (through `backend.start()`). The caller
 *  must have already registered the agent DB in the registry under
 *  `res.runtimeRoot` (config/runSql resolve by that key). Teardown is left to the
 *  caller — hosts dispose in different orders and may also need to dispose the
 *  JsRuntime, so each composes its own `dispose` from the returned pieces. */
export async function createAgentRuntime(res: AgentRuntimeResources): Promise<AgentRuntimeCore> {
  const { agentId, runtimeRoot, store } = res

  const providerRegistry = new ProviderRegistry()
  providerRegistry.register(createOpenAICompatibleFactory({
    getConfig: (key, fallback) => getConfigValue(runtimeRoot, key, fallback),
    setConfig: (key, value) => setAgentConfig(runtimeRoot, key, value),
  }))

  const functionRegistry = new FunctionRegistry()
  const eventBus = new EventBus()
  const busPublish = (topic: string, data: unknown) => eventBus.publish(topic, data)

  res.loadExtras?.({ runtimeRoot, busPublish, providerRegistry, functionRegistry })

  const traceWriter = res.createTraceWriter ? res.createTraceWriter(store) : new TraceWriter(store)
  const jsRuntime = res.createJsRuntime(functionRegistry, traceWriter)

  const sessionManager = new AgentSessionManager({
    runtimeRoot,
    store,
    providerRegistry,
    getJsRuntime: () => jsRuntime,
    busPublish,
    ...(res.notificationHost ? { notificationHost: res.notificationHost } : {}),
  })

  const taskRunner = new TaskRunner({
    runtimeRoot,
    store,
    getJsRuntime: () => jsRuntime,
    busPublish,
  })

  registerAllBuiltInFunctions(functionRegistry, {
    runtimeRoot,
    store,
    getSessionManager: () => sessionManager,
    getTaskRunner: () => taskRunner,
    eventBus,
    providerRegistry,
    ...(res.pageTools ? { pageTools: res.pageTools } : {}),
    ...(res.getCommandPalette ? { getCommandPalette: res.getCommandPalette } : {}),
    ...(res.rendererPush ? { rendererPush: res.rendererPush } : {}),
    ...(res.externalLauncher ? { externalLauncher: res.externalLauncher } : {}),
  })

  const backend = new LocalBackend({
    agentId,
    runtimeRoot,
    store,
    sessionManager,
    functionRegistry,
    providerRegistry,
    taskRunner,
    traceWriter,
    files: res.files,
    backup: res.backup,
  })
  await backend.start()

  return {
    backend,
    providerRegistry,
    functionRegistry,
    eventBus,
    busPublish,
    traceWriter,
    jsRuntime,
    sessionManager,
    taskRunner,
  }
}
