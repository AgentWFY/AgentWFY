// Node bootstrap for a local-in-process agent runtime. Used by both the Electron
// desktop (via AgentContextFactory.createLocal) and the server daemon (via
// createAgentRuntime). The shared construction — providers, functions, sessions,
// tasks, the LocalBackend — lives in the host-neutral `createAgentRuntime`
// factory (./agent_runtime.ts); this file supplies the Node-specific resources
// (fs DB + file store, `child_process` JsRuntime, fs files/backup, plugins) and
// wires the Node TriggerEngine + teardown around the returned core. Callers
// provide host bundles for environment-bound surfaces (tabs, palette,
// notifications, renderer push, external launcher) and a DB-change listener.

import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createAgentRuntime } from './agent_runtime.js'
import type { LocalBackend } from '../backend/local.js'
import type { AgentSessionManager } from './session_manager.js'
import type { EventBus } from '../event-bus.js'
import type { FunctionRegistry } from '../runtime/function_registry.js'
import { JsRuntime } from '../runtime/js_runtime.js'
import type { TraceWriter } from '../runtime/trace_writer.js'
import type {
  ExternalLauncher,
  NotificationHost,
  PaletteHost,
  RendererPush,
} from '../runtime/hosts.js'
import type { PageApi } from '../page/types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { TaskRunner } from '../task-runner/task_runner.js'
import { TriggerEngine } from '../triggers/engine.js'
import { loadPlugins } from '../plugins/loader.js'
import type { PluginRegistry } from '../plugins/registry.js'
import { closeAgentDb, getOrCreateAgentDb } from '../db/agent-db.js'
import '../db/sqlite-file.js' // side effect: installs the Node `sqlite-file` runSql handler
import { NodeFileStore } from '../storage/node-file-store.js'
import type { FileStore } from '../storage/file-store.js'
import type { AgentDbChange } from '../db/sqlite.js'
import { ensureViewsSchema } from '../db/views.js'
import { getConfigValue, configureGlobalConfigProvider } from '../settings/config.js'
import { globalConfigExists, globalConfigGet } from '../settings/global-config.js'
import { backupAgentDb, getBackupStatus, listAllBackups, restoreFromBackup } from '../backup.js'
import { readAgentFile, statAgentFile } from '../backend/files.js'
import { SystemConfigKeys } from '../system-config/keys.js'

const AGENT_DIR_NAME = '.agentwfy'

// Node host wiring for the node-free config/SQL seams: resolve the user-wide
// `~/.agentwfy.json` global config from the fs-bound `global-config.ts`. A host
// without a home dir skips this, resolving config purely from the agent DB.
configureGlobalConfigProvider({ exists: globalConfigExists, get: globalConfigGet })

export interface LocalRuntimeHosts {
  notificationHost?: NotificationHost
  pageTools?: PageApi
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
  /** Build the TraceWriter for this agent. Defaults to one backed by the
   *  agent's FileStore. */
  createTraceWriter?: (store: FileStore) => TraceWriter
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

  const fileStore = new NodeFileStore(runtimeRoot)

  // Captured from the plugin-loader hook, which runs inside `createAgentRuntime`
  // (synchronously, before built-ins register) so plugin providers/functions
  // slot in ahead of the built-ins — exactly as before the extraction.
  let pluginRegistry: PluginRegistry | null = null

  const core = await createAgentRuntime({
    agentId: runtimeRoot,
    runtimeRoot,
    store: fileStore,
    files: {
      read: ({ path, offset, limit }) => readAgentFile(runtimeRoot, path, { offset, limit }),
      stat: ({ path }) => statAgentFile(runtimeRoot, path),
    },
    backup: {
      create: () => backupAgentDb(runtimeRoot),
      restore: ({ version }) => restoreFromBackup(runtimeRoot, version),
      list: () => listAllBackups(runtimeRoot),
      status: () => getBackupStatus(runtimeRoot),
    },
    createJsRuntime: opts.createJsRuntime
      ?? ((functionRegistry, traceWriter) => new JsRuntime({ functionRegistry, traceWriter })),
    ...(opts.createTraceWriter ? { createTraceWriter: opts.createTraceWriter } : {}),
    loadExtras: ({ runtimeRoot: root, busPublish, providerRegistry, functionRegistry }) => {
      pluginRegistry = loadPlugins(root, busPublish, providerRegistry, functionRegistry)
    },
    ...(hosts?.notificationHost ? { notificationHost: hosts.notificationHost } : {}),
    ...(hosts?.pageTools ? { pageTools: hosts.pageTools } : {}),
    ...(hosts?.getCommandPalette ? { getCommandPalette: hosts.getCommandPalette } : {}),
    ...(hosts?.rendererPush ? { rendererPush: hosts.rendererPush } : {}),
    ...(hosts?.externalLauncher ? { externalLauncher: hosts.externalLauncher } : {}),
  })

  const { backend, eventBus, providerRegistry, functionRegistry, sessionManager, taskRunner, jsRuntime, traceWriter } = core

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
    busPublish: core.busPublish,
  })

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
