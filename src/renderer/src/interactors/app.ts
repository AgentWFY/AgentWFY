import { attachRunSqlEventListener } from './sql'
import { loadViewCatalog } from 'app/interactors/external_views'
import type { ViewCatalogEntry } from 'app/interactors/external_views'
import type { ElectronAgentDbChange, ElectronAgentDbChangedEvent } from 'app/electron_agent_tools'
import { AGENT_RUNTIME_V2_ENABLED } from 'app/runtime_flags'

let unlistenAgentDbChanged: (() => void) | null = null
let catalogRefreshInFlight = false
let catalogRefreshQueued = false

function dispatchViewsLoaded(entries: ViewCatalogEntry[]) {
  window.dispatchEvent(new CustomEvent<{ views: ViewCatalogEntry[] }>('tradinglog:views-loaded', {
    detail: { views: entries }
  }))
}

async function refreshViewCatalog() {
  try {
    const entries = await loadViewCatalog()
    dispatchViewsLoaded(entries)
  } catch (e) {
    console.error('Failed to load view catalog:', e)
  }
}

function queueViewCatalogRefresh() {
  if (catalogRefreshInFlight) {
    catalogRefreshQueued = true
    return
  }

  catalogRefreshInFlight = true
  void refreshViewCatalog().finally(() => {
    catalogRefreshInFlight = false
    if (catalogRefreshQueued) {
      catalogRefreshQueued = false
      queueViewCatalogRefresh()
    }
  })
}

function normalizeViewChanges(detail: ElectronAgentDbChangedEvent): ElectronAgentDbChange[] {
  if (!detail || !Array.isArray(detail.changes)) {
    return []
  }

  const viewChanges: ElectronAgentDbChange[] = []
  for (const change of detail.changes) {
    if (!change || change.table !== 'views') continue
    if (change.op !== 'insert' && change.op !== 'update' && change.op !== 'delete') continue
    if (typeof change.rowId !== 'number' || !Number.isFinite(change.rowId)) continue
    viewChanges.push(change)
  }

  return viewChanges
}

function subscribeToAgentDbChanges() {
  if (!AGENT_RUNTIME_V2_ENABLED) {
    return
  }

  const tools = window.electronClientTools
  if (!tools?.onAgentDbChanged) {
    return
  }

  if (unlistenAgentDbChanged) {
    unlistenAgentDbChanged()
    unlistenAgentDbChanged = null
  }

  unlistenAgentDbChanged = tools.onAgentDbChanged((detail: ElectronAgentDbChangedEvent) => {
    const viewChanges = normalizeViewChanges(detail)
    if (!viewChanges.length) {
      return
    }

    queueViewCatalogRefresh()
    window.dispatchEvent(new CustomEvent<{ changes: ElectronAgentDbChange[] }>('tradinglog:views-db-changed', {
      detail: { changes: viewChanges }
    }))
  })
}

export async function initApp() {
  attachRunSqlEventListener()
  queueViewCatalogRefresh()
  subscribeToAgentDbChanges()
}

export function destroyApp() {
  if (unlistenAgentDbChanged) {
    unlistenAgentDbChanged()
    unlistenAgentDbChanged = null
  }
}
