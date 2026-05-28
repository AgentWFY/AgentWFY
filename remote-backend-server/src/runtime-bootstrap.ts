import { createLocalAgentRuntime } from '#shared/agent/local_runtime.js'
import { LocalBackend } from '#shared/backend/local.js'
import { FunctionRegistry } from '#shared/runtime/function_registry.js'
import { registerClientFunctionProxies, type ClientFunctionInvoker } from '#shared/runtime/client-functions.js'
import { TabRouter } from '#shared/runtime/tab-router.js'
import { getAgentDbCurrentVersion, getOrCreateAgentDb } from '#shared/db/agent-db.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import {
  installPackageData,
  readValidatedPackage,
  readValidatedPackageFromBytes,
  uninstallPlugin,
} from '#shared/plugins/installer.js'
import {
  scheduleBackup,
  rescheduleBackupForAgent,
  stopBackupSchedulerForAgent,
} from '#shared/backup-scheduler.js'
import { runCleanup } from '#shared/cleanup.js'
import { SystemConfigKeys } from '#shared/system-config/keys.js'
import path from 'node:path'
import type { loadPlugins } from '#shared/plugins/loader.js'
import { createHeadlessChromeBrowserHostFromEnv } from './browser/headless-chrome.js'

export interface RuntimeBundle {
  backend: LocalBackend
  dbChanges: {
    subscribe(handler: (change: AgentDbChange) => void): () => void
  }
  /** One-off "the DB was replaced out-of-band" notifications (currently only
   *  emitted after backup.restore). Subscribers should discard cached state
   *  and re-snapshot. */
  dbResets: {
    subscribe(handler: () => void): () => void
    emit(): void
  }
  /** Current DB change-log version. Read after RPCs / on hello so remote
   *  mirrors can sync their `localVersion`. */
  getDbVersion(): number
  dispose(): Promise<void>
}

export async function createAgentRuntime(
  runtimeRoot: string,
  clientFunctionInvoker?: ClientFunctionInvoker,
): Promise<RuntimeBundle> {
  const dbChangeSubscribers = new Set<(change: AgentDbChange) => void>()
  const dbResetSubscribers = new Set<() => void>()
  let triggerReloadTimer: ReturnType<typeof setTimeout> | null = null
  const browserHost = await createHeadlessChromeBrowserHostFromEnv({ runtimeRoot }).catch((err) => {
    console.warn('[runtime] headless browser host unavailable:', err)
    return null
  })

  const runtime = await createLocalAgentRuntime({
    runtimeRoot,
    hosts: {
      tabTools: new TabRouter({
        browserHost: browserHost ?? undefined,
        clientInvoker: clientFunctionInvoker,
      }),
    },
    onDbChange: (change) => {
      if (change.table === 'triggers') {
        if (triggerReloadTimer) clearTimeout(triggerReloadTimer)
        triggerReloadTimer = setTimeout(() => {
          triggerReloadTimer = null
          runtime.triggerEngine.reload().catch(err => {
            console.error('[triggers] Reload failed:', err)
          })
        }, 500)
      }
      if (change.table === 'config' && change.rowId === SystemConfigKeys.backupIntervalHours) {
        rescheduleBackupForAgent(runtimeRoot)
      }
      for (const handler of dbChangeSubscribers) {
        try {
          handler(change)
        } catch (err) {
          console.warn('[runtime] db change subscriber failed:', err)
        }
      }
    },
  })

  if (runtime.pluginRegistry) {
    registerRemotePluginManagement({
      runtimeRoot,
      functionRegistry: runtime.functionRegistry,
      clientFunctionInvoker,
      pluginRegistry: runtime.pluginRegistry,
    })
  }

  if (clientFunctionInvoker) {
    registerClientFunctionProxies(runtime.functionRegistry, clientFunctionInvoker)
  }

  runtime.triggerEngine.start().catch(err => {
    console.error('[triggers] Start failed:', err)
  })

  scheduleBackup(runtimeRoot).catch(err => {
    console.error('[backup] Schedule failed:', err)
  })

  runCleanup(runtimeRoot).catch(err => {
    console.error('[cleanup] failed:', err)
  })

  const dispose = async (): Promise<void> => {
    if (triggerReloadTimer) {
      clearTimeout(triggerReloadTimer)
      triggerReloadTimer = null
    }
    stopBackupSchedulerForAgent(runtimeRoot)
    await runtime.dispose()
    runtime.jsRuntime.disposeAll()
    await runtime.traceWriter.flush()
    await browserHost?.dispose().catch((err) => console.warn('[runtime] browser host dispose failed:', err))
    dbChangeSubscribers.clear()
    dbResetSubscribers.clear()
  }

  return {
    backend: runtime.backend,
    dbChanges: {
      subscribe(handler) {
        dbChangeSubscribers.add(handler)
        return () => {
          dbChangeSubscribers.delete(handler)
        }
      },
    },
    dbResets: {
      subscribe(handler) {
        dbResetSubscribers.add(handler)
        return () => {
          dbResetSubscribers.delete(handler)
        }
      },
      emit() {
        for (const handler of dbResetSubscribers) {
          try {
            handler()
          } catch (err) {
            console.warn('[runtime] db reset subscriber failed:', err)
          }
        }
      },
    },
    getDbVersion: () => getAgentDbCurrentVersion(runtimeRoot),
    dispose,
  }
}

function resolveAgentPath(runtimeRoot: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath) ? requestedPath : path.resolve(runtimeRoot, requestedPath)
}

function publicPluginMeta(plugin: {
  code?: string
  name: string
  title?: string
  description?: string
  version?: string
  author?: string | null
  repository?: string | null
  license?: string | null
  enabled?: number
}): Record<string, unknown> {
  const { code: _code, ...meta } = plugin
  return meta
}

function registerRemotePluginManagement(opts: {
  runtimeRoot: string
  functionRegistry: FunctionRegistry
  clientFunctionInvoker?: ClientFunctionInvoker
  pluginRegistry: ReturnType<typeof loadPlugins>
}): void {
  const requireClient = (): ClientFunctionInvoker => {
    if (!opts.clientFunctionInvoker) {
      throw new Error('A connected desktop client is required for plugin confirmation')
    }
    return opts.clientFunctionInvoker
  }

  const confirmAndInstall = async (
    packageData: ReturnType<typeof readValidatedPackage>,
    displayPath: string,
  ): Promise<{ installed: string[] }> => {
    const confirmed = await requireClient().invokeClientFunction('_confirmPluginInstall', {
      packagePath: displayPath,
      plugins: packageData.plugins.map(publicPluginMeta),
    })
    if (confirmed !== true) return { installed: [] }

    const result = installPackageData(opts.runtimeRoot, packageData)
    const db = getOrCreateAgentDb(opts.runtimeRoot)
    for (const name of result.installed) {
      const row = db.getPlugin(name)
      if (row) opts.pluginRegistry.reloadPlugin(row)
    }
    return result
  }

  opts.functionRegistry.register('requestInstallPlugin', async (params) => {
    const request = params as { packagePath?: string } | undefined
    if (!request || typeof request.packagePath !== 'string' || request.packagePath.trim().length === 0) {
      throw new Error('requestInstallPlugin requires a non-empty packagePath string')
    }
    const packagePath = resolveAgentPath(opts.runtimeRoot, request.packagePath)
    return confirmAndInstall(readValidatedPackage(packagePath), packagePath)
  })

  // Bytes variant: used by the desktop's file-picker flow when this agent is
  // remote — the picked file lives on the desktop's filesystem, not the
  // daemon's, so requestInstallPlugin's path-based form can't reach it.
  opts.functionRegistry.register('requestInstallPluginFromBytes', async (params) => {
    const request = params as { fileName?: string; packageBytes?: string } | undefined
    if (!request || typeof request.packageBytes !== 'string' || request.packageBytes.length === 0) {
      throw new Error('requestInstallPluginFromBytes requires base64 packageBytes')
    }
    const bytes = Buffer.from(request.packageBytes, 'base64')
    const displayName = typeof request.fileName === 'string' && request.fileName.trim().length > 0
      ? request.fileName.trim()
      : 'uploaded.plugins.awfy'
    return confirmAndInstall(readValidatedPackageFromBytes(bytes), displayName)
  })

  opts.functionRegistry.register('requestTogglePlugin', async (params) => {
    const request = params as { pluginName?: string } | undefined
    if (!request || typeof request.pluginName !== 'string' || request.pluginName.trim().length === 0) {
      throw new Error('requestTogglePlugin requires a non-empty pluginName string')
    }

    const db = getOrCreateAgentDb(opts.runtimeRoot)
    const plugin = db.getPluginInfo(request.pluginName)
    if (!plugin) throw new Error(`Plugin '${request.pluginName}' not found`)

    const currentEnabled = !!plugin.enabled
    const confirmed = await requireClient().invokeClientFunction('_confirmPluginToggle', {
      pluginName: request.pluginName,
      title: plugin.title,
      currentEnabled,
      description: plugin.description,
      version: plugin.version,
      author: plugin.author,
      license: plugin.license,
    })
    if (confirmed !== true) return { toggled: false }

    const nextEnabled = !currentEnabled
    db.togglePlugin(request.pluginName, nextEnabled)
    if (nextEnabled) {
      const row = db.getPlugin(request.pluginName)
      if (row) opts.pluginRegistry.loadPlugin(row)
    } else {
      opts.pluginRegistry.unloadPlugin(request.pluginName)
    }
    return { toggled: true, enabled: nextEnabled }
  })

  opts.functionRegistry.register('requestUninstallPlugin', async (params) => {
    const request = params as { pluginName?: string } | undefined
    if (!request || typeof request.pluginName !== 'string' || request.pluginName.trim().length === 0) {
      throw new Error('requestUninstallPlugin requires a non-empty pluginName string')
    }

    const db = getOrCreateAgentDb(opts.runtimeRoot)
    const plugin = db.getPluginInfo(request.pluginName)
    if (!plugin) throw new Error(`Plugin '${request.pluginName}' not found`)

    const confirmed = await requireClient().invokeClientFunction('_confirmPluginUninstall', {
      pluginName: request.pluginName,
      title: plugin.title,
      description: plugin.description,
      version: plugin.version,
      author: plugin.author,
      license: plugin.license,
    })
    if (confirmed !== true) return { uninstalled: false }

    opts.pluginRegistry.unloadPlugin(request.pluginName)
    uninstallPlugin(opts.runtimeRoot, request.pluginName)
    return { uninstalled: true }
  })
}
