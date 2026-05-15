// WebSocket protocol for RemoteBackend <-> remote-backend-server.
//
// Transport:
//   - One authenticated WebSocket connection at /api/v1/ws.
//   - Bidirectional RPC messages use request/response envelopes.
//   - Backend events are pushed as one-way event envelopes.
//
// Auth:
//   - Desktop clients pass the per-agent token as ?token=<token>.
//   - Authorization: Bearer <token> is also accepted for non-browser clients.
//
// This file must remain free of:
//   - Electron imports
//   - node:* imports
//   - DOM globals

import type {
  AgentDbChange,
} from '../db/sqlite.js'
import type {
  AgentBackendEvent,
  FunctionInfo,
  ProviderState,
  RunningTaskSummary,
  SessionHandle,
  SessionState,
  SessionSummary,
  SpawnSessionRequest,
} from './interface.js'
import type { ProviderInfo } from '../agent/provider_types.js'
import type { TaskOrigin } from '../task-runner/task_runner.js'

export const PROTOCOL_VERSION = 'v1' as const
export const API_PREFIX = `/api/${PROTOCOL_VERSION}` as const
export const WS_PATH = `${API_PREFIX}/ws` as const
export const DB_SNAPSHOT_PATH = `${API_PREFIX}/db/snapshot` as const

export const AUTH_HEADER = 'authorization' as const
export const AUTH_SCHEME = 'Bearer' as const

export function formatAuthHeader(token: string): string {
  return `${AUTH_SCHEME} ${token}`
}

export interface WireError {
  name: string
  message: string
  code?: string
}

export interface ErrorResponse {
  error: WireError
}

export function errorFromUnknown(error: unknown): WireError {
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message || String(error) }
  }
  return { name: 'Error', message: String(error) }
}

export function messageFromUnknown(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Unknown error'
  if (typeof error === 'string') return error || 'Unknown error'
  if (error && typeof error === 'object') {
    const maybe = error as { message?: unknown; name?: unknown }
    if (typeof maybe.message === 'string' && maybe.message) return maybe.message
    if (typeof maybe.name === 'string' && maybe.name) return maybe.name
  }
  const text = String(error)
  return text === '[object Object]' ? 'Unknown error' : text
}

export class ProtocolError extends Error {
  readonly code?: string

  constructor(name: string, message: string, code?: string) {
    super(message)
    this.name = name
    if (code !== undefined) this.code = code
  }
}

// RPC method names are dotted so the server can dispatch with a small switch
// and still keep domains readable in traces/logs.
export type BackendRpcMethod =
  | 'health'
  | 'whoami'
  | 'sessions.list'
  | 'sessions.get'
  | 'sessions.spawn'
  | 'sessions.send'
  | 'sessions.abort'
  | 'sessions.remove'
  | 'functions.list'
  | 'functions.invoke'
  | 'providers.list'
  | 'providers.getState'
  | 'providers.getStatusLine'
  | 'providers.setDefault'
  | 'config.set'
  | 'config.clear'
  | 'config.remove'
  | 'tasks.start'
  | 'tasks.stop'
  | 'tasks.listRunning'

export type ClientRpcMethod =
  | 'client.functions.invoke'

export type RpcMethod = BackendRpcMethod | ClientRpcMethod

export interface WsRpcRequest {
  type: 'rpc'
  id: string
  method: RpcMethod
  params: unknown
}

export interface WsRpcResult {
  type: 'rpc:result'
  id: string
  ok: true
  value: unknown
}

export interface WsRpcError {
  type: 'rpc:result'
  id: string
  ok: false
  error: WireError
}

export interface WsBackendEvent {
  type: 'event'
  id: number
  event: AgentBackendEvent
}

export interface WsDbChanged {
  type: 'db:changed'
  id: number
  change: AgentDbChange
}

export interface WsHello {
  type: 'hello'
  protocolVersion: typeof PROTOCOL_VERSION
  agentId: string
  capabilities: {
    tabs: boolean
    clientFunctionProxy: boolean
  }
}

export type WsMessage =
  | WsHello
  | WsRpcRequest
  | WsRpcResult
  | WsRpcError
  | WsBackendEvent
  | WsDbChanged

export function encodeWsMessage(message: WsMessage): string {
  return JSON.stringify(message)
}

export function decodeWsMessage(raw: string): WsMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProtocolError('ProtocolError', 'WebSocket message is not valid JSON')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ProtocolError('ProtocolError', 'WebSocket message must be an object')
  }

  const msg = parsed as { type?: unknown }
  if (typeof msg.type !== 'string') {
    throw new ProtocolError('ProtocolError', 'WebSocket message is missing type')
  }

  return parsed as WsMessage
}

// Request / response payloads.
export interface WhoamiResponse {
  agentId: string
  protocolVersion: typeof PROTOCOL_VERSION
  capabilities: {
    tabs: boolean
    clientFunctionProxy: boolean
  }
}

export interface SessionsListRequest { limit?: number; offset?: number; since?: number; until?: number }
export type SessionsListResponse = SessionSummary[]

export interface SessionsGetRequest { sessionId: string }
export type SessionsGetResponse = SessionState | null

export type SessionsSpawnRequest = SpawnSessionRequest
export type SessionsSpawnResponse = SessionHandle

export interface SessionsSendRequest { sessionId: string; text: string }
export type SessionsSendResponse = { ok: true }

export interface SessionsAbortRequest { sessionId: string }
export type SessionsAbortResponse = { ok: true }

export interface SessionsRemoveRequest { sessionId: string }
export type SessionsRemoveResponse = { ok: true }

export type FunctionsListResponse = FunctionInfo[]
export interface FunctionsInvokeRequest { name: string; params: unknown }
export interface FunctionsInvokeResponse { value: unknown }

export interface ClientFunctionsInvokeRequest { name: string; params: unknown }
export interface ClientFunctionsInvokeResponse { value: unknown }

// Providers
export type ProvidersListResponse = ProviderInfo[]
export type ProvidersGetStateResponse = ProviderState
export interface ProvidersGetStatusLineRequest { providerId: string }
export interface ProvidersGetStatusLineResponse { statusLine: string }
export interface ProvidersSetDefaultRequest { providerId: string }
export type ProvidersSetDefaultResponse = ProviderState

// Config
export interface ConfigSetRequest { name: string; value: unknown }
export interface ConfigClearRequest { name: string }
export interface ConfigRemoveRequest { name: string }
export type ConfigMutationResponse = { ok: true }

// Tasks
export interface TasksStartRequest { taskName: string; input?: unknown; origin?: TaskOrigin }
export interface TasksStartResponse { runId: string }
export interface TasksStopRequest { runId: string }
export type TasksStopResponse = { ok: true }
export type TasksListRunningResponse = RunningTaskSummary[]
