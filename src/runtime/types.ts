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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface WorkerGetTabsRequest {}

export type WorkerGetTabsResult = Array<{
  id: string
  title: string
  type: string
  target: string | null
  viewUpdatedAt: number | null
  viewChanged: boolean
  pinned: boolean
  hidden: boolean
  selected: boolean
  params: Record<string, string> | null
}>

export interface WorkerOpenTabRequest {
  viewName?: string
  filePath?: string
  url?: string
  title?: string
  hidden?: boolean
  params?: Record<string, string>
}

export interface WorkerCloseTabRequest {
  id?: string
  tabId?: string
}

export interface WorkerSelectTabRequest {
  id?: string
  tabId?: string
}

export interface WorkerReloadTabRequest {
  id?: string
  tabId?: string
}

export interface WorkerCaptureTabRequest {
  id?: string
  tabId?: string
}

export interface WorkerGetTabConsoleLogsRequest {
  id?: string
  tabId?: string
  since?: number
  limit?: number
}

export interface WorkerExecTabJsRequest {
  id?: string
  tabId?: string
  code: string
  timeoutMs?: number
}

export interface WorkerSendInputRequest {
  id?: string
  tabId?: string
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

export interface WorkerInspectElementRequest {
  id?: string
  tabId?: string
  selector: string
}

export interface WorkerTabDebuggerSendRequest {
  id?: string
  tabId?: string
  method: string
  params?: unknown
  sessionId?: string
}

export interface WorkerTabDebuggerSubscribeRequest {
  id?: string
  tabId?: string
  events: string[]
}

export interface WorkerTabDebuggerSubscribeResult {
  subscriptionId: string
}

export interface WorkerTabDebuggerPollRequest {
  subscriptionId: string
  maxBatch?: number
  maxWaitMs?: number
}

export interface WorkerTabDebuggerBufferedEvent {
  method: string
  params: unknown
  sessionId?: string
  /** Set on the first event of a poll batch when events were dropped before it. */
  dropped?: number
}

export interface WorkerTabDebuggerPollResult {
  events: WorkerTabDebuggerBufferedEvent[]
  dropped: number
  closed: boolean
}

export interface WorkerTabDebuggerUnsubscribeRequest {
  subscriptionId: string
}

export interface WorkerTabDebuggerDetachRequest {
  id?: string
  tabId?: string
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
  getTabs: {
    params: WorkerGetTabsRequest
    result: WorkerGetTabsResult
  }
  openTab: {
    params: WorkerOpenTabRequest
    result: { id: string; tabId: string }
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
  sendInput: {
    params: WorkerSendInputRequest
    result: void
  }
  inspectElement: {
    params: WorkerInspectElementRequest
    result: unknown
  }
  tabDebuggerSend: {
    params: WorkerTabDebuggerSendRequest
    result: unknown
  }
  tabDebuggerSubscribe: {
    params: WorkerTabDebuggerSubscribeRequest
    result: WorkerTabDebuggerSubscribeResult
  }
  tabDebuggerPoll: {
    params: WorkerTabDebuggerPollRequest
    result: WorkerTabDebuggerPollResult
  }
  tabDebuggerUnsubscribe: {
    params: WorkerTabDebuggerUnsubscribeRequest
    result: void
  }
  tabDebuggerDetach: {
    params: WorkerTabDebuggerDetachRequest
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
