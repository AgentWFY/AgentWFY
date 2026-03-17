export type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'

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

export interface ExecJsCapturedImage {
  base64: string
  mimeType: string
}

export interface ExecJsDetails {
  ok: boolean
  value?: unknown
  error?: ExecJsSerializedError
  logs: ExecJsLogEntry[]
  images: ExecJsCapturedImage[]
  timeoutMs: number
}

export interface WorkerRunSqlRequest {
  target?: 'agent' | 'sqlite-file'
  path?: string
  sql: string
  params?: unknown[]
  description?: string
}

export interface WorkerReadRequest {
  path: string
  offset?: number
  limit?: number
}

export interface WorkerWriteRequest {
  path: string
  content: string
}

export interface WorkerWriteBinaryRequest {
  path: string
  base64: string
}

export interface WorkerEditRequest {
  path: string
  oldText: string
  newText: string
}

export interface WorkerLsRequest {
  path?: string
  limit?: number
}

export interface WorkerMkdirRequest {
  path: string
  recursive?: boolean
}

export interface WorkerRemoveRequest {
  path: string
  recursive?: boolean
}

export interface WorkerFindRequest {
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

export interface WorkerGrepRequest {
  pattern: string
  path?: string
  options?: WorkerGrepOptions
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WorkerGetTabsRequest {}

export interface WorkerGetTabsResult {
  tabs: Array<{
    id: string
    title: string
    viewId: string | number | null
    viewUpdatedAt: number | null
    viewChanged: boolean
    pinned: boolean
    hidden: boolean
    selected: boolean
  }>
}

export interface WorkerOpenTabRequest {
  viewId?: string | number
  filePath?: string
  url?: string
  title?: string
  hidden?: boolean
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

export interface WorkerCaptureTabResult {
  base64: string
  mimeType: 'image/png'
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
    result: void
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
  getTabConsoleLogs: {
    params: WorkerGetTabConsoleLogsRequest
    result: WorkerTabConsoleLogEntry[]
  }
  execTabJs: {
    params: WorkerExecTabJsRequest
    result: unknown
  }
  setRequestHeaders: {
    params: { tid: string; headers: Record<string, string> }
    result: void
  }
  busPublish: {
    params: { topic: string; data: unknown }
    result: void
  }
  busWaitFor: {
    params: { topic: string; timeoutMs?: number }
    result: unknown
  }
  spawnAgent: {
    params: { prompt: string }
    result: { agentId: string }
  }
  sendToAgent: {
    params: { agentId: string; message: string }
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
  ffmpeg: {
    params: { args: string[] }
    result: { id: string }
  }
  ffmpegKill: {
    params: { id: string }
    result: void
  }
}

export interface WorkerStartTaskRequest {
  taskId: number
  input?: unknown
}

export interface WorkerStartTaskResult {
  runId: string
}

export interface WorkerStopTaskRequest {
  runId: string
}

export type WorkerHostMethod = keyof WorkerHostMethodMap

export interface WorkerExecuteRequestMessage {
  type: 'exec:run'
  requestId: string
  code: string
  timeoutMs: number
  input?: unknown
  pluginMethods?: string[]
}

export interface WorkerCancelRequestMessage {
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

export interface WorkerWatchLogsMessage {
  type: 'exec:watch'
  requestId: string
}

export interface WorkerUnwatchLogsMessage {
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
  method: WorkerHostMethod
  params: unknown
}

export interface WorkerExecutionResultMessage {
  type: 'exec:result'
  requestId: string
  details: ExecJsDetails
}

export interface WorkerLogStreamMessage {
  type: 'exec:log'
  requestId: string
  logEntry: ExecJsLogEntry
}

export type WorkerToHostMessage =
  | WorkerHostCallMessage
  | WorkerExecutionResultMessage
  | WorkerLogStreamMessage
