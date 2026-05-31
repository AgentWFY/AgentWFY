import type { RemoteAgentContext } from './agent-context.js'
import { EventBus } from '#shared/event-bus.js'
import { RemoteBackend } from '#shared/backend/remote.js'
import { RemoteChatController } from './chat/remote_chat_controller.js'
import type { RemoteAgentConfig } from './agent-meta.js'
import { RemoteAgentDbSync } from './remote-agent-db-sync.js'
import type { TabViewManager } from './tab-view-manager.js'
import type { ShortcutManager } from './shortcuts/manager.js'
import { FunctionRegistry } from '#shared/runtime/function_registry.js'
import type { PaletteHost, TabApi } from '#shared/runtime/hosts.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import { registerTabs } from '#shared/runtime/functions/tabs.js'
import { registerPages } from '#shared/runtime/functions/pages.js'
import { registerPalette } from '#shared/runtime/functions/palette.js'
import { registerOpenExternal } from '#shared/runtime/functions/index.js'
import { getElectronExternalLauncher } from './runtime/hosts-electron.js'
import { PageManager } from '#shared/page/page-manager.js'
import { LegacyTabPageHost } from '#shared/page/legacy-tab-page-host.js'

export async function createRemoteAgentContext(opts: {
  agentId: string
  cacheRoot: string
  remoteConfig: RemoteAgentConfig
  shortcutManager: ShortcutManager
  tabViewManager: TabViewManager
  tabTools: TabApi
  getCommandPalette?: () => PaletteHost
  onLocalDbChange?: (change: AgentDbChange) => void
  onSnapshotApplied?: () => void
}): Promise<RemoteAgentContext> {
  const { agentId, cacheRoot, remoteConfig, shortcutManager, tabViewManager, tabTools } = opts

  const clientFunctionRegistry = createClientFunctionRegistry({
    cacheRoot,
    tabTools,
    getCommandPalette: opts.getCommandPalette,
  })

  const remoteBackend = new RemoteBackend({
    id: agentId,
    baseUrl: remoteConfig.baseUrl,
    agentToken: remoteConfig.agentToken,
    desktopFunctions: clientFunctionRegistry,
  })
  const dbSync = new RemoteAgentDbSync({
    cacheRoot,
    remoteBackend,
    onLocalDbChange: opts.onLocalDbChange,
    onSnapshotApplied: opts.onSnapshotApplied,
  })
  remoteBackend.attachDbSync(dbSync)
  try {
    await remoteBackend.start()
  } catch (err) {
    // The backend's WsClient stays in reconnecting state on its own, and the
    // orchestrator's status subscription will surface 'disconnected' / 'error'
    // in the sidebar — keep the context alive so the app window can load.
    console.warn(
      '[agent-context-remote] backend.start failed; agent will operate in disconnected mode:',
      err,
    )
  }

  const eventBus = new EventBus()

  const ctx: RemoteAgentContext = {
    mode: 'remote',
    agentId,
    cacheRoot,
    eventBus,
    backend: remoteBackend,
    chat: new RemoteChatController(remoteBackend),
    statusUnsubscribe: null,
    eventsUnsubscribe: null,
    chatPump: null,
    dbChangeDebounceTimer: null,
    triggerReloadDebounceTimer: null,
    taskActionsReloadDebounceTimer: null,
    providerStatePushTimer: null,
    tabViewManager,
    shortcutManager,
    tabTools,
    remoteConfig,
  }

  return ctx
}

export async function destroyRemoteAgentContext(ctx: RemoteAgentContext): Promise<void> {
  await ctx.backend.stop().catch((err) => {
    console.warn('[agent-context-remote] backend.stop failed:', err)
  })
  ctx.eventBus.dispose()
}

function createClientFunctionRegistry(opts: {
  cacheRoot: string
  tabTools: TabApi
  getCommandPalette?: () => PaletteHost
}): FunctionRegistry {
  const registry = new FunctionRegistry()
  const pageTools = new PageManager({
    agentId: opts.cacheRoot,
    hosts: [new LegacyTabPageHost(opts.tabTools, { agentId: opts.cacheRoot })],
  })
  registerPages(registry, { pageTools, runtimeRoot: opts.cacheRoot })
  registerTabs(registry, { tabTools: opts.tabTools, runtimeRoot: opts.cacheRoot }, { hidden: true })
  if (opts.getCommandPalette) {
    registerPalette(registry, { getCommandPalette: opts.getCommandPalette })
    registry.register('_confirmPluginInstall', async (params) => {
      const req = params as { packagePath?: string; plugins?: Array<Record<string, unknown>> }
      const host = opts.getCommandPalette?.()
      if (!host?.confirmPluginInstall) {
        throw new Error('Plugin install confirmation is not available')
      }
      if (typeof req.packagePath !== 'string' || !Array.isArray(req.plugins)) {
        throw new Error('_confirmPluginInstall requires packagePath and plugins')
      }
      return host.confirmPluginInstall(req.packagePath, req.plugins)
    }, 'built-in', { hidden: true })
    registry.register('_confirmPluginToggle', async (params) => {
      const req = params as Record<string, unknown> & { currentEnabled?: unknown }
      const host = opts.getCommandPalette?.()
      if (!host?.confirmPluginToggle) {
        throw new Error('Plugin toggle confirmation is not available')
      }
      if (typeof req.currentEnabled !== 'boolean') {
        throw new Error('_confirmPluginToggle requires currentEnabled')
      }
      return host.confirmPluginToggle(req as Record<string, unknown> & { currentEnabled: boolean })
    }, 'built-in', { hidden: true })
    registry.register('_confirmPluginUninstall', async (params) => {
      const req = params as Record<string, unknown>
      const host = opts.getCommandPalette?.()
      if (!host?.confirmPluginUninstall) {
        throw new Error('Plugin uninstall confirmation is not available')
      }
      return host.confirmPluginUninstall(req)
    }, 'built-in', { hidden: true })
  }

  registerOpenExternal(registry, getElectronExternalLauncher())

  return registry
}
