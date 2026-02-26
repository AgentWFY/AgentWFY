import { sendSqlRequest, SqlApiError } from 'app/api'
import type { PendingSqlConfirmation, TabData } from 'app/types'
import type { SqlRequestParams, SqlTarget } from 'app/api_types'

export interface RunSqlEventDetail {
  requestId: string
  target?: SqlTarget
  path?: string
  sql: string
  params?: any[]
  description?: string
  sender?: string
}

export interface RunSqlResponseEventDetail {
  requestId: string
  target?: SqlTarget
  path?: string
  sql: string
  params?: any[]
  description?: string
  result?: any
  error?: string
}

const DEFAULT_RUN_SQL_SENDER = 'ai-agent'
let isRunSqlEventListenerAttached = false

let pendingSqlConfirmation: PendingSqlConfirmation | null = null

export function attachRunSqlEventListener() {
  if (typeof window === 'undefined' || isRunSqlEventListenerAttached) {
    return
  }

  window.addEventListener('agentwfy:run-sql', onRunSqlEvent as EventListener, { capture: true })
  isRunSqlEventListenerAttached = true
}

export async function runSql(sql: string) {
  try {
    return await sendSqlRequest({ sql, sender: DEFAULT_RUN_SQL_SENDER })
  } catch (e) {
    console.error('Failed to run sql query', e)
  }
}

export function handleRunSqlEvent(
  detail: RunSqlEventDetail,
  sender: string
) {
  if (
    !detail ||
    !detail.requestId ||
    !detail.sql ||
    (typeof detail.target !== 'undefined' && !isSqlTarget(detail.target)) ||
    (detail.target === 'sqlite-file' && (!detail.path || detail.path.trim().length === 0))
  ) {
    dispatchRunSqlResponse({
      requestId: detail?.requestId || '',
      target: detail?.target,
      path: detail?.path,
      sql: detail?.sql || '',
      params: detail?.params,
      description: detail?.description,
      error: 'Invalid run-sql event payload',
    })
    return
  }

  const request: SqlRequestParams = {
    target: detail.target,
    path: detail.path,
    sql: detail.sql,
    params: detail.params,
    description: detail.description,
    sender,
  }

  void executeSqlRequest(detail.requestId, request)
}

function onRunSqlEvent(event: Event) {
  const customEvent = event as CustomEvent<RunSqlEventDetail>
  const detail = customEvent.detail
  const sender = resolveRunSqlSender(customEvent, detail)
  handleRunSqlEvent(detail, sender)
}

function isSqlTarget(value: unknown): value is SqlTarget {
  return value === 'agent' || value === 'sqlite-file'
}

function resolveExplicitSender(detail: RunSqlEventDetail | undefined): string | null {
  if (!detail || typeof detail.sender !== 'string') {
    return null
  }

  const sender = detail.sender.trim()
  return sender.length > 0 ? sender : null
}

function resolveRunSqlSender(
  event: CustomEvent<RunSqlEventDetail>,
  detail: RunSqlEventDetail | undefined
): string {
  const explicitSender = resolveExplicitSender(detail)
  if (explicitSender) {
    return explicitSender
  }

  const targetSender = getExternalViewSenderFromEventPath(event)
  if (targetSender) {
    return targetSender
  }

  return DEFAULT_RUN_SQL_SENDER
}

function getExternalViewSenderFromEventPath(event: CustomEvent<RunSqlEventDetail>): string | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (!(node instanceof HTMLElement)) {
      continue
    }

    const tagName = node.tagName?.toLowerCase()
    if (tagName && tagName.startsWith('ext-view-')) {
      const tabsEl = document.querySelector('tl-tabs') as any
      const tabs: TabData[] = tabsEl?.tabs ?? []
      const tab = tabs.find((t: TabData) => t.dataType === 'external-view')
      if (typeof tab?.viewId === 'number' || typeof tab?.viewId === 'string') {
        return String(tab.viewId)
      }
      return 'external-view'
    }
  }

  return null
}

export function confirmPendingSqlConfirmation() {
  const pending = getPendingSqlConfirmation()
  if (!pending) {
    return
  }

  clearPending()
  void executeSqlRequest(pending.requestId, {
    target: pending.target,
    path: pending.path,
    sql: pending.sql,
    params: pending.params,
    description: pending.description,
    sender: pending.sender,
    confirmed: true,
  })
}

export function cancelPendingSqlConfirmation(reason?: Error) {
  const pending = getPendingSqlConfirmation()
  if (!pending) {
    return
  }

  clearPending()
  dispatchRunSqlResponse({
    requestId: pending.requestId,
    target: pending.target,
    path: pending.path,
    sql: pending.sql,
    params: pending.params,
    description: pending.description,
    error: reason?.message || 'SQL request cancelled by user',
  })
}

function setPending(confirmation: PendingSqlConfirmation) {
  pendingSqlConfirmation = confirmation
  window.dispatchEvent(new CustomEvent('agentwfy:sql-confirmation-needed', {
    detail: confirmation
  }))
}

function clearPending() {
  pendingSqlConfirmation = null
  window.dispatchEvent(new CustomEvent('agentwfy:sql-confirmation-cleared'))
}

function queuePendingSqlRequest(
  requestId: string,
  request: SqlRequestParams
) {
  if (getPendingSqlConfirmation()) {
    dispatchRunSqlResponse({
      requestId,
      target: request.target,
      path: request.path,
      sql: request.sql,
      params: request.params,
      description: request.description,
      error: 'Another SQL confirmation is already pending',
    })
    return
  }

  const confirmation: PendingSqlConfirmation = {
    requestId,
    target: request.target,
    path: request.path,
    sql: request.sql,
    params: request.params,
    description: request.description,
    sender: request.sender,
  }

  setPending(confirmation)
}

function getPendingSqlConfirmation(): PendingSqlConfirmation | null {
  return pendingSqlConfirmation
}

async function executeSqlRequest(
  requestId: string,
  request: SqlRequestParams
) {
  try {
    const result = await executeSqlByTarget(request)
    dispatchRunSqlResponse({
      requestId,
      target: request.target,
      path: request.path,
      sql: request.sql,
      params: request.params,
      description: request.description,
      result,
    })
  } catch (e) {
    if (isReadOnlyViolationError(e)) {
      queuePendingSqlRequest(requestId, request)
      return
    }

    console.error('Failed to execute run-sql request', e)
    dispatchRunSqlResponse({
      requestId,
      target: request.target,
      path: request.path,
      sql: request.sql,
      params: request.params,
      description: request.description,
      error: getErrorMessage(e),
    })
  }
}

async function executeSqlByTarget(request: SqlRequestParams) {
  if (!request.target) {
    return sendSqlRequest(request)
  }

  const tools = window.electronAgentTools
  if (!tools?.runSql) {
    throw new Error('window.electronAgentTools.runSql is not available in this renderer context')
  }

  if (request.target === 'sqlite-file' && (!request.path || request.path.trim().length === 0)) {
    throw new Error('SQL target "sqlite-file" requires a path')
  }

  return tools.runSql({
    target: request.target,
    path: request.path,
    sql: request.sql,
    params: request.params,
    description: request.description,
    confirmed: request.confirmed,
  })
}

function isReadOnlyViolationError(error: unknown): boolean {
  if (error instanceof SqlApiError && error.status === 422 && typeof error.body === 'string') {
    return error.body.startsWith('ReadOnlyViolation:')
  }

  return getErrorMessage(error).startsWith('ReadOnlyViolation:')
}

function dispatchRunSqlResponse(detail: RunSqlResponseEventDetail) {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent<RunSqlResponseEventDetail>('agentwfy:run-sql-response', {
    detail,
  }))
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error)
  } catch {
    return 'Unknown error'
  }
}
