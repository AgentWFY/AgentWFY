import type { AgentTool, AgentToolResult, ImageContent, TextContent } from './types.js'
import { getJsRuntime } from '../runtime/js_runtime.js'
import type { ExecJsDetails } from '../runtime/types.js'
import { stringifyUnknown } from './tool_utils.js'

interface CreateExecJsToolArgs {
  getSessionId: () => string
}

export const EXECJS_TOOL_DESCRIPTION = [
  'Execute JavaScript in a dedicated session worker and return result + captured console output.',
  'Runtime API and agentview workflow details are defined in the system prompt sections [execjs.runtime] and [agentviews].',
].join('\n')

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
    images: [],
    timeoutMs,
  }
}

function buildToolResult(details: ExecJsDetails): AgentToolResult<ExecJsDetails> {
  const hasImages = details.images && details.images.length > 0

  // Strip images from text serialization — they're included as ImageContent
  const textDetails = hasImages ? { ...details, images: `[${details.images.length} image(s) attached]` } : details
  const text = truncate(stringifyUnknown(textDetails), 200000)
  const content: (TextContent | ImageContent)[] = [{ type: 'text', text }]

  if (hasImages) {
    for (const image of details.images) {
      content.push({ type: 'image', data: image.base64, mimeType: image.mimeType })
    }
  }

  return { content, details }
}

export function createExecJsTool(args: CreateExecJsToolArgs): AgentTool {
  return {
    name: 'execJs',
    label: 'Execute JavaScript',
    description: EXECJS_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short human-readable description of what this code does (shown to the user).',
        },
        code: {
          type: 'string',
          description: 'JavaScript code to execute. Use explicit return for result values.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 120000,
          description: 'Execution timeout in milliseconds (default 5000).',
        },
      },
      required: ['description', 'code'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params, signal) => {
      const typedParams = params as { code: string; timeoutMs?: number }
      const timeoutMs = typedParams.timeoutMs ?? 5000

      try {
        const sessionId = args.getSessionId()
        const manager = getJsRuntime()
        const details = await manager.executeExecJs(sessionId, typedParams.code, timeoutMs, signal)
        return buildToolResult(details)
      } catch (error) {
        const details = toFailureDetails(error, timeoutMs)
        return buildToolResult(details)
      }
    },
  }
}
