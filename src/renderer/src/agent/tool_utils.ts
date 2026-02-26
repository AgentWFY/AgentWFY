import type { AgentToolResult } from '@mariozechner/pi-agent-core'

export function requireElectronTools() {
  if (!window.electronAgentTools) {
    throw new Error('window.electronAgentTools is not available in this renderer context')
  }

  return window.electronAgentTools
}

export function requireClientTools() {
  if (!window.electronClientTools) {
    throw new Error('window.electronClientTools is not available in this renderer context')
  }

  return window.electronClientTools
}

export function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: 'text', text }],
    details
  }
}
