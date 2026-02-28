export function requireElectronTools() {
  if (!window.agentwfy) {
    throw new Error('window.agentwfy is not available in this renderer context')
  }

  return window.agentwfy
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
