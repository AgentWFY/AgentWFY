import type { RemoteAgentContext } from './agent-context.js'
import { EventBus } from '#shared/event-bus.js'
import { RemoteBackend } from '#shared/backend/remote.js'
import { RemoteChatController } from './chat/remote_chat_controller.js'
import type { RemoteAgentConfig } from './agent-meta.js'
import { RemoteAgentDbSync } from './remote-agent-db-sync.js'
import type { TabViewManager } from './tab-view-manager.js'
import type { ShortcutManager } from './shortcuts/manager.js'
import type { PaletteHost } from '#shared/runtime/hosts.js'
import type { PageApi } from '#shared/page/types.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import { createClientFunctionRegistry } from '#shared/runtime/client-function-registry.js'
import { getElectronExternalLauncher } from './runtime/hosts-electron.js'

export async function createRemoteAgentContext(opts: {
  agentId: string
  cacheRoot: string
  remoteConfig: RemoteAgentConfig
  shortcutManager: ShortcutManager
  tabViewManager: TabViewManager
  pageTools: PageApi
  getCommandPalette?: () => PaletteHost
  onLocalDbChange?: (change: AgentDbChange) => void
  onSnapshotApplied?: () => void
}): Promise<RemoteAgentContext> {
  const { agentId, cacheRoot, remoteConfig, shortcutManager, tabViewManager, pageTools } = opts

  const clientFunctionRegistry = createClientFunctionRegistry({
    getPaletteHost: opts.getCommandPalette,
    externalLauncher: getElectronExternalLauncher(),
  })

  const remoteBackend = new RemoteBackend({
    id: agentId,
    baseUrl: remoteConfig.baseUrl,
    agentToken: remoteConfig.agentToken,
    clientFunctions: clientFunctionRegistry,
    clientPages: pageTools,
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
    pageTools,
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
