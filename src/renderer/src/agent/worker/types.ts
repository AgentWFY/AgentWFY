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

export interface ExecJsDetails {
  ok: boolean
  value?: unknown
  error?: ExecJsSerializedError
  logs: ExecJsLogEntry[]
  timeoutMs: number
}

export interface WorkerRunSqlRequest {
  target?: 'agent' | 'sqlite-file'
  path?: string
  sql: string
  params?: any[]
  description?: string
  confirmed?: boolean
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

export interface WorkerCaptureViewRequest {
  viewId: string | number
}

export interface WorkerGetViewConsoleLogsRequest {
  viewId: string | number
  since?: number
  limit?: number
}

export interface WorkerExecViewJsRequest {
  viewId: string | number
  code: string
  timeoutMs?: number
}

export interface WorkerViewConsoleLogEntry {
  level: string
  message: string
  timestamp: number
}

export interface WorkerCaptureViewResult {
  base64: string
  mimeType: 'image/png'
}

export interface WorkerHostMethodMap {
  runSql: {
    params: WorkerRunSqlRequest
    result: any
  }
  read: {
    params: WorkerReadRequest
    result: string
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
  captureView: {
    params: WorkerCaptureViewRequest
    result: WorkerCaptureViewResult
  }
  getViewConsoleLogs: {
    params: WorkerGetViewConsoleLogsRequest
    result: WorkerViewConsoleLogEntry[]
  }
  execViewJs: {
    params: WorkerExecViewJsRequest
    result: any
  }
}

export type WorkerHostMethod = keyof WorkerHostMethodMap

export interface WorkerExecuteRequestMessage {
  type: 'exec:run'
  requestId: string
  code: string
  timeoutMs: number
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

export type HostToWorkerMessage =
  | WorkerExecuteRequestMessage
  | WorkerCancelRequestMessage
  | WorkerHostResultMessage

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

export type WorkerToHostMessage =
  | WorkerHostCallMessage
  | WorkerExecutionResultMessage
