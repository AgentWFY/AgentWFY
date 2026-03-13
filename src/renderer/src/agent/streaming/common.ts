/**
 * Shared streaming helpers used by all provider implementations.
 */
import type { AssistantMessage, Model, StopReason, ToolCall } from '../types.js'
import { emitError, isRetryableStatus, type MessageStream, type StreamOptions } from './types.js'
import { parseSSE } from './sse.js'

// ── Snapshot helper ──

/** Shallow-copy a partial message so downstream consumers get a stable snapshot. */
export function snapshot(partial: AssistantMessage): AssistantMessage {
  return { ...partial, content: [...partial.content] }
}

// ── Message init ──

export function createPartial(model: Model): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    provider: model.provider.id,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: 'end',
    timestamp: Date.now(),
  }
}

export function emitStart(stream: MessageStream, partial: AssistantMessage): void {
  stream.push({ type: 'start', partial: snapshot(partial) })
}

// ── Fetch with unified error handling ──

export async function fetchStream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  stream: MessageStream,
  model: Model,
  options: StreamOptions,
  providerLabel: string,
): Promise<Response | null> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (err) {
    const errorMessage = options.signal?.aborted
      ? 'Request aborted'
      : (err instanceof Error ? err.message : String(err))
    emitError(stream, model, errorMessage, options.signal?.aborted ? 'aborted' : 'error', !options.signal?.aborted)
    return null
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    emitError(stream, model, `${providerLabel} API error (${response.status}): ${text || response.statusText}`, 'error', isRetryableStatus(response.status))
    return null
  }

  return response
}

// ── SSE iteration with abort handling ──

export interface SSEData {
  eventType: string | undefined
  data: Record<string, unknown>
}

export async function* iterateSSE(
  response: Response,
): AsyncGenerator<SSEData, void, undefined> {
  for await (const sseEvent of parseSSE(response)) {
    if (sseEvent.data === '[DONE]') break

    let data: Record<string, unknown>
    try {
      data = JSON.parse(sseEvent.data)
    } catch {
      continue
    }

    yield { eventType: sseEvent.event, data }
  }
}

/** Handle stream-level errors (abort vs real error). */
export function handleStreamError(
  err: unknown,
  stream: MessageStream,
  model: Model,
  partial: AssistantMessage,
  options: StreamOptions,
): void {
  if (options.signal?.aborted) {
    partial.stopReason = 'aborted'
    partial.errorMessage = 'Request aborted'
    stream.push({ type: 'done', partial: snapshot(partial) })
    return
  }
  emitError(stream, model, err instanceof Error ? err.message : String(err), 'error', true)
}

// ── Finalize ──

export function emitDone(
  stream: MessageStream,
  partial: AssistantMessage,
  stopReason: StopReason,
): void {
  partial.usage.totalTokens = partial.usage.input + partial.usage.output
  partial.stopReason = stopReason
  stream.push({ type: 'done', partial: snapshot(partial) })
}

// ── Tool call accumulation ──

export interface ToolCallBuilderEntry {
  contentIndex: number
  id: string
  name: string
  args: string
}

/**
 * Manages in-progress tool calls across streaming deltas.
 * Works for both index-keyed (OpenAI) and string-keyed (Codex) tracking.
 */
export class ToolCallAccumulator<K extends string | number = string | number> {
  private builders = new Map<K, ToolCallBuilderEntry>()

  /** Register a new tool call. Pushes a toolCall content block and emits toolcall_start. */
  start(
    key: K,
    id: string,
    name: string,
    partial: AssistantMessage,
    stream: MessageStream,
  ): ToolCallBuilderEntry {
    const contentIndex = partial.content.length
    partial.content.push({
      type: 'toolCall',
      id,
      name,
      arguments: {},
    })
    const entry: ToolCallBuilderEntry = { contentIndex, id, name, args: '' }
    this.builders.set(key, entry)
    stream.push({ type: 'toolcall_start', contentIndex, partial: snapshot(partial) })
    return entry
  }

  get(key: K): ToolCallBuilderEntry | undefined {
    return this.builders.get(key)
  }

  has(key: K): boolean {
    return this.builders.has(key)
  }

  /** Append argument delta and emit toolcall_delta. */
  appendArgs(
    entry: ToolCallBuilderEntry,
    delta: string,
    partial: AssistantMessage,
    stream: MessageStream,
  ): void {
    entry.args += delta
    stream.push({
      type: 'toolcall_delta',
      contentIndex: entry.contentIndex,
      delta,
      partial: snapshot(partial),
    })
  }

  /** Finalize a single tool call: parse accumulated JSON args and emit toolcall_end. */
  finish(
    entry: ToolCallBuilderEntry,
    partial: AssistantMessage,
    stream: MessageStream,
  ): void {
    const toolCall = partial.content[entry.contentIndex] as ToolCall
    toolCall.id = entry.id
    toolCall.name = entry.name
    try {
      toolCall.arguments = JSON.parse(entry.args)
    } catch {
      toolCall.arguments = {}
    }
    stream.push({
      type: 'toolcall_end',
      contentIndex: entry.contentIndex,
      toolCall: { ...toolCall },
      partial: snapshot(partial),
    })
  }

  /** Finalize all pending tool calls (used by OpenAI which doesn't have per-call done events). */
  finishAll(partial: AssistantMessage, stream: MessageStream): void {
    for (const entry of this.builders.values()) {
      this.finish(entry, partial, stream)
    }
  }

  get size(): number {
    return this.builders.size
  }
}
