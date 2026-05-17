import path from 'path'
import { isValidTraceSessionId } from './trace_types.js'

export const TRACES_RELATIVE_DIR = '.agentwfy/traces'

export function getTraceDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, TRACES_RELATIVE_DIR)
}

export function getTraceFilePath(runtimeRoot: string, sessionId: string): string | null {
  if (!isValidTraceSessionId(sessionId)) return null
  return path.join(getTraceDir(runtimeRoot), `${sessionId}.jsonl`)
}
