import type { AppIpc } from '../ipc-types/index.js'

export function requireIpc(): AppIpc {
  if (!window.ipc) {
    throw new Error('window.ipc is not available in this renderer context')
  }

  return window.ipc
}

export function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
