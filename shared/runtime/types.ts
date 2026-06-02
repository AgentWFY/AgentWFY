import type { DisplayMessage } from '../agent/provider_types.js'
import type { TaskOrigin, TaskRunStatus } from '../task-runner/task_runner.js'
import type {
  PageCdpBufferedEvent,
  PageCloseAfterIdleMs,
  PageInfo,
  PageScreenshot,
  PageSource,
} from '../page/types.js'

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'

export interface ExecJsLogEntry {
  level: ConsoleMethod
  message: string
  timestamp: number
}

export interface ExecJsSerializedError {
  name: string
  message: string
  stack?: string
}

export interface ExecJsCapturedFile {
  base64: string
  mimeType: string
}

export interface ExecJsDetails {
  ok: boolean
  value?: unknown
  error?: ExecJsSerializedError
  logs: ExecJsLogEntry[]
  files: ExecJsCapturedFile[]
  timeoutMs: number
}

export interface WorkerRunSqlRequest {
  target?: 'agent' | 'sqlite-file'
  path?: string
  sql: string
  params?: unknown[]
  description?: string
}

interface WorkerReadRequest {
  path: string
  offset?: number
  limit?: number
  asBase64?: boolean
}

interface WorkerReadBinaryResult {
  base64: string
  mimeType: string
  size: number
}

interface WorkerWriteRequest {
  path: string
  content?: string
  base64?: string
}

interface WorkerEditRequest {
  path: string
  edits: Array<{ oldText: string; newText: string }>
}

interface WorkerLsRequest {
  path?: string
  limit?: number
}

interface WorkerMkdirRequest {
  path: string
  recursive?: boolean
}

interface WorkerRemoveRequest {
  path: string
  recursive?: boolean
}

interface WorkerRenameRequest {
  oldPath: string
  newPath: string
}

interface WorkerFindRequest {
  pattern: string
  path?: string
  limit?: number
}

export interface WorkerGrepOptions {
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
  glob?: string
  filesOnly?: boolean
}

interface WorkerGrepRequest {
  pattern: string
  path?: string
  options?: WorkerGrepOptions
}

export interface WorkerGetPagesRequest {
  headless?: boolean
}

export type WorkerGetPagesResult = PageInfo[]

export interface WorkerOpenPageRequest {
  source: PageSource
  title?: string
  width?: number
  height?: number
  closeAfterIdleMs?: PageCloseAfterIdleMs
}

export interface WorkerOpenPageResult {
  id: string
  pageId: string
  page: PageInfo
  info: string
}

export interface WorkerOpenClientPageRequest {
  source: PageSource
  title?: string
}

export interface WorkerOpenClientPageResult {
  id: string
  pageId: string
  page: PageInfo
  info: string
}

export interface WorkerPageIdRequest {
  id?: string
  pageId?: string
}

export interface WorkerCapturePageRequest extends WorkerPageIdRequest {
  allowFallback?: boolean
}

export interface WorkerGetPageConsoleLogsRequest extends WorkerPageIdRequest {
  since?: number
  limit?: number
}

export interface WorkerRunPageJsRequest extends WorkerPageIdRequest {
  code: string
  timeoutMs?: number
}

export interface WorkerSendPageInputRequest extends WorkerPageIdRequest {
  type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'click' | 'mouseWheel' | 'keyDown' | 'keyUp' | 'char'
  x?: number
  y?: number
  button?: 'left' | 'middle' | 'right'
  clickCount?: number
  deltaX?: number
  deltaY?: number
  keyCode?: string
  modifiers?: string[]
}

export interface WorkerInspectPageElementRequest extends WorkerPageIdRequest {
  selector: string
}

export interface WorkerSendPageCdpRequest extends WorkerPageIdRequest {
  method: string
  params?: unknown
  sessionId?: string
}

export interface WorkerSubscribePageCdpRequest extends WorkerPageIdRequest {
  events: string[]
}

export interface WorkerSubscribePageCdpResult {
  subscriptionId: string
}

export interface WorkerPollPageCdpRequest {
  subscriptionId: string
  maxBatch?: number
  maxWaitMs?: number
}

export interface WorkerPageCdpBufferedEvent extends PageCdpBufferedEvent {
  /** Set on the first event of a poll batch when events were dropped before it. */
  dropped?: number
}

export interface WorkerPageCdpPollResult {
  events: WorkerPageCdpBufferedEvent[]
  dropped: number
  closed: boolean
}

export interface WorkerUnsubscribePageCdpRequest {
  subscriptionId: string
}

export interface WorkerDetachPageCdpRequest extends WorkerPageIdRequest {}

export interface WorkerPageConsoleLogEntry {
  level: string
  message: string
  timestamp: number
}

export interface WorkerHostMethodMap {
  runSql: {
    params: WorkerRunSqlRequest
    result: unknown
  }
  read: {
    params: WorkerReadRequest
    result: string | WorkerReadBinaryResult
  }
  write: {
    params: WorkerWriteRequest
    result: string
  }
  edit: {
    params: WorkerEditRequest
    result: string
  }
  ls: {
    params: WorkerLsRequest
    result: string[]
  }
  mkdir: {
    params: WorkerMkdirRequest
    result: void
  }
  remove: {
    params: WorkerRemoveRequest
    result: void
  }
  rename: {
    params: WorkerRenameRequest
    result: string
  }
  find: {
    params: WorkerFindRequest
    result: string
  }
  grep: {
    params: WorkerGrepRequest
    result: string
  }
  getPages: {
    params: WorkerGetPagesRequest
    result: WorkerGetPagesResult
  }
  openPage: {
    params: WorkerOpenPageRequest
    result: WorkerOpenPageResult
  }
  openClientPage: {
    params: WorkerOpenClientPageRequest
    result: WorkerOpenClientPageResult
  }
  closePage: {
    params: WorkerPageIdRequest
    result: void
  }
  reloadPage: {
    params: WorkerPageIdRequest
    result: PageInfo
  }
  getCurrentClientPage: {
    params: Record<string, never>
    result: PageInfo | null
  }
  capturePage: {
    params: WorkerCapturePageRequest
    result: PageScreenshot
  }
  getPageConsoleLogs: {
    params: WorkerGetPageConsoleLogsRequest
    result: WorkerPageConsoleLogEntry[]
  }
  runPageJs: {
    params: WorkerRunPageJsRequest
    result: unknown
  }
  sendPageInput: {
    params: WorkerSendPageInputRequest
    result: void
  }
  inspectPageElement: {
    params: WorkerInspectPageElementRequest
    result: unknown
  }
  sendPageCdp: {
    params: WorkerSendPageCdpRequest
    result: unknown
  }
  subscribePageCdp: {
    params: WorkerSubscribePageCdpRequest
    result: WorkerSubscribePageCdpResult
  }
  pollPageCdp: {
    params: WorkerPollPageCdpRequest
    result: WorkerPageCdpPollResult
  }
  unsubscribePageCdp: {
    params: WorkerUnsubscribePageCdpRequest
    result: void
  }
  detachPageCdp: {
    params: WorkerDetachPageCdpRequest
    result: void
  }
  publish: {
    params: { topic: string; data: unknown }
    result: void
  }
  waitFor: {
    params: { topic: string; timeoutMs?: number }
    result: unknown
  }
  spawnSession: {
    params: { prompt: string; providerId?: string; providerOptions?: Record<string, unknown> }
    result: { sessionId: string }
  }
  sendToSession: {
    params: { sessionId: string; message: string }
    result: void
  }
  openSessionInChat: {
    params: { sessionId: string }
    result: void
  }
  listSessions: {
    params: { limit?: number; offset?: number; since?: number; until?: number }
    result: Array<{ sessionId: string; title: string; providerId: string; updatedAt: number }>
  }
  searchSessions: {
    params: {
      pattern: string
      ignoreCase?: boolean
      literal?: boolean
      limit?: number
      matchesPerSession?: number
      since?: number
      until?: number
    }
    result: Array<{
      sessionId: string
      title: string
      updatedAt: number
      matches: Array<{ messageIndex: number; role: 'user' | 'assistant'; snippet: string }>
    }>
  }
  readSession: {
    params: { sessionId: string }
    result: { sessionId: string; title: string; providerId: string; updatedAt: number; messages: DisplayMessage[] }
  }
  startTask: {
    params: WorkerStartTaskRequest
    result: WorkerStartTaskResult
  }
  stopTask: {
    params: WorkerStopTaskRequest
    result: void
  }
  listTaskRuns: {
    params: {
      limit?: number
      offset?: number
      since?: number
      until?: number
      status?: TaskRunStatus
    }
    result: Array<{
      runId: string
      taskName: string
      title: string
      status: TaskRunStatus
      origin: TaskOrigin
      startedAt: number
      finishedAt?: number
    }>
  }
  searchTaskRuns: {
    params: {
      pattern: string
      ignoreCase?: boolean
      literal?: boolean
      limit?: number
      matchesPerRun?: number
      since?: number
      until?: number
    }
    result: Array<{
      runId: string
      taskName: string
      status: TaskRunStatus
      startedAt: number
      matches: Array<{ where: 'log' | 'result' | 'error' | 'input'; logIndex?: number; snippet: string }>
    }>
  }
  readTaskRun: {
    params: { runId: string }
    result: {
      runId: string
      taskName: string
      title: string
      status: TaskRunStatus
      origin: TaskOrigin
      input: unknown
      startedAt: number
      finishedAt: number | null
      result: unknown
      error: string | null
      logs: ExecJsLogEntry[]
    }
  }
  requestInstallPlugin: {
    params: { packagePath: string }
    result: { installed: string[] }
  }
  requestTogglePlugin: {
    params: { pluginName: string }
    result: { toggled: boolean; enabled?: boolean }
  }
  requestUninstallPlugin: {
    params: { pluginName: string }
    result: { uninstalled: boolean }
  }
  pickFromPalette: {
    params: {
      items: Array<{ title: string; subtitle?: string; value: unknown }>
      title?: string
      placeholder?: string
      timeoutMs?: number
    }
    result: unknown | null
  }
  getAvailableFunctions: {
    params: Record<string, never>
    result: Array<{ name: string; docs?: string[] }>
  }
  getAvailableProviders: {
    params: Record<string, never>
    result: Array<{ id: string; name: string }>
  }
  openExternal: {
    params: { url: string }
    result: void
  }
}

interface WorkerStartTaskRequest {
  taskName: string
  input?: unknown
}

interface WorkerStartTaskResult {
  runId: string
}

interface WorkerStopTaskRequest {
  runId: string
}

export interface WorkerExecuteRequestMessage {
  type: 'exec:run'
  requestId: string
  code: string
  timeoutMs: number
  timeoutWasDefault: boolean
  input?: unknown
  methods: string[]
}

interface WorkerCancelRequestMessage {
  type: 'exec:cancel'
  requestId: string
}

export interface WorkerHostResultMessage {
  type: 'host:result'
  requestId: string
  callId: string
  ok: boolean
  value?: unknown
  error?: ExecJsSerializedError
}

interface WorkerWatchLogsMessage {
  type: 'exec:watch'
  requestId: string
}

interface WorkerUnwatchLogsMessage {
  type: 'exec:unwatch'
  requestId: string
}

export type HostToWorkerMessage =
  | WorkerExecuteRequestMessage
  | WorkerCancelRequestMessage
  | WorkerHostResultMessage
  | WorkerWatchLogsMessage
  | WorkerUnwatchLogsMessage

export interface WorkerHostCallMessage {
  type: 'host:call'
  requestId: string
  callId: string
  method: string
  params: unknown
}

interface WorkerExecutionResultMessage {
  type: 'exec:result'
  requestId: string
  details: ExecJsDetails
}

interface WorkerLogStreamMessage {
  type: 'exec:log'
  requestId: string
  logEntry: ExecJsLogEntry
}

interface WorkerCrashMessage {
  type: 'worker:crash'
  error: ExecJsSerializedError
}

export type WorkerToHostMessage =
  | WorkerHostCallMessage
  | WorkerExecutionResultMessage
  | WorkerLogStreamMessage
  | WorkerCrashMessage
