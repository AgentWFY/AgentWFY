import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'
import { getSessionWorkerManager } from 'app/agent/worker/session_worker_manager'
import type { ExecJsDetails } from 'app/agent/worker/types'
import { stringifyUnknown, textResult } from 'app/agent/tool_utils'

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
    timeoutMs,
  }
}

export function createExecJsTool(args: CreateExecJsToolArgs): AgentTool {
  return {
    name: 'execJs',
    label: 'Execute JavaScript',
    description: EXECJS_TOOL_DESCRIPTION,
    parameters: Type.Object({
      code: Type.String({ description: 'JavaScript code to execute. Use explicit return for result values.' }),
      timeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 120000,
        description: 'Execution timeout in milliseconds (default 5000).',
      })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params: any, signal) => {
      const timeoutMs = params.timeoutMs ?? 5000

      try {
        const sessionId = args.getSessionId()
        const manager = getSessionWorkerManager()
        const details = await manager.executeExecJs(sessionId, params.code, timeoutMs, signal)
        return textResult(truncate(stringifyUnknown(details), 50000), details)
      } catch (error) {
        const details = toFailureDetails(error, timeoutMs)
        return textResult(truncate(stringifyUnknown(details), 50000), details)
      }
    },
  }
}
