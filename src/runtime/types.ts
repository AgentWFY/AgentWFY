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
}

interface WorkerWriteRequest {
  path: string
  content: string
}

interface WorkerWriteBinaryRequest {
  path: string
  base64: string
}

interface WorkerEditRequest {
  path: string
  oldText: string
  newText: string
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
}

interface WorkerGrepRequest {
  pattern: string
  path?: string
  options?: WorkerGrepOptions
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface WorkerGetTabsRequest {}

export interface WorkerGetTabsResult {
  tabs: Array<{
    id: string
    title: string
    viewName: string | null
    viewUpdatedAt: number | null
    viewChanged: boolean
    pinned: boolean
    hidden: boolean
    selected: boolean
  }>
}

export interface WorkerOpenTabRequest {
  viewName?: string
  filePath?: string
  url?: string
  title?: string
  hidden?: boolean
  params?: Record<string, string>
}

export interface WorkerCloseTabRequest {
  tabId: string
}

export interface WorkerSelectTabRequest {
  tabId: string
}

export interface WorkerReloadTabRequest {
  tabId: string
}

export interface WorkerCaptureTabRequest {
  tabId: string
}

export interface WorkerGetTabConsoleLogsRequest {
  tabId: string
  since?: number
  limit?: number
}

export interface WorkerExecTabJsRequest {
  tabId: string
  code: string
  timeoutMs?: number
}

export interface WorkerTabConsoleLogEntry {
  level: 'verbose' | 'info' | 'warning' | 'error'
  message: string
  timestamp: number
}

interface WorkerCaptureTabResult {
  base64: string
  mimeType: string
}

interface WorkerReadBinaryRequest {
  path: string
}

interface WorkerReadBinaryResult {
  base64: string
  mimeType: string
  size: number
}

export interface WorkerHostMethodMap {
  runSql: {
    params: WorkerRunSqlRequest
    result: unknown
  }
  read: {
    params: WorkerReadRequest
    result: string
  }
  write: {
    params: WorkerWriteRequest
    result: string
  }
  writeBinary: {
    params: WorkerWriteBinaryRequest
    result: string
  }
  edit: {
    params: WorkerEditRequest
    result: string
  }
  ls: {
    params: WorkerLsRequest
    result: string
  }
  mkdir: {
    params: WorkerMkdirRequest
    result: void
  }
  remove: {
    params: WorkerRemoveRequest
    result: void
  }
  find: {
    params: WorkerFindRequest
    result: string
  }
  grep: {
    params: WorkerGrepRequest
    result: string
  }
  getTabs: {
    params: WorkerGetTabsRequest
    result: WorkerGetTabsResult
  }
  openTab: {
    params: WorkerOpenTabRequest
    result: { tabId: string }
  }
  closeTab: {
    params: WorkerCloseTabRequest
    result: void
  }
  selectTab: {
    params: WorkerSelectTabRequest
    result: void
  }
  reloadTab: {
    params: WorkerReloadTabRequest
    result: void
  }
  captureTab: {
    params: WorkerCaptureTabRequest
    result: WorkerCaptureTabResult
  }
  readBinary: {
    params: WorkerReadBinaryRequest
    result: WorkerReadBinaryResult
  }
  getTabConsoleLogs: {
    params: WorkerGetTabConsoleLogsRequest
    result: WorkerTabConsoleLogEntry[]
  }
  execTabJs: {
    params: WorkerExecTabJsRequest
    result: unknown
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
  startTask: {
    params: WorkerStartTaskRequest
    result: WorkerStartTaskResult
  }
  stopTask: {
    params: WorkerStopTaskRequest
    result: void
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
  getAvailableFunctions: {
    params: Record<string, never>
    result: Array<{ name: string; source: string }>
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
