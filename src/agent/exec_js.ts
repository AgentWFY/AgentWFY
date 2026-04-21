import type { AgentTool, AgentToolResult, FileContent, TextContent } from './types.js'
import type { ExecJsDetails } from '../runtime/types.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import { EXECJS_TOOL_DEFINITION } from './provider_types.js'
import { stringifyUnknown } from './tool_utils.js'

interface CreateExecJsToolArgs {
  getSessionId: () => string
  getJsRuntime: () => JsRuntime
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...<truncated ${text.length - maxChars} chars>`
}

function serializeError(error: unknown): ExecJsDetails['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    name: 'Error',
    message: stringifyUnknown(error),
  }
}

function toFailureDetails(error: unknown, timeoutMs: number): ExecJsDetails {
  return {
    ok: false,
    error: serializeError(error),
    logs: [],
    files: [],
    timeoutMs,
  }
}

function buildToolResult(details: ExecJsDetails): AgentToolResult<ExecJsDetails> {
  const hasFiles = details.files && details.files.length > 0

  // Strip files from text serialization — they're included as FileContent
  const textDetails = hasFiles ? { ...details, files: `[${details.files.length} file(s) attached]` } : details
  const text = truncate(stringifyUnknown(textDetails), 50000)
  const content: (TextContent | FileContent)[] = [{ type: 'text', text }]

  if (hasFiles) {
    for (const file of details.files) {
      if (file.base64) {
        content.push({ type: 'file', data: file.base64, mimeType: file.mimeType })
      }
    }
  }

  return { content, details }
}

export function createExecJsTool(args: CreateExecJsToolArgs): AgentTool {
  return {
    name: EXECJS_TOOL_DEFINITION.name,
    label: 'Execute JavaScript',
    description: EXECJS_TOOL_DEFINITION.description,
    parameters: EXECJS_TOOL_DEFINITION.parameters as Record<string, unknown>,
    execute: async (_toolCallId, params, signal) => {
      const typedParams = params as { code: string; timeoutMs?: number }
      const timeoutMs = typedParams.timeoutMs ?? 10000

      try {
        const runtime = args.getJsRuntime()
        const sessionId = args.getSessionId()

        const details = await runtime.executeExecJs(sessionId, typedParams.code, timeoutMs, signal) as ExecJsDetails
        return buildToolResult(details)
      } catch (error) {
        const details = toFailureDetails(error, timeoutMs)
        return buildToolResult(details)
      }
    },
  }
}
