function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false

  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export const AGENT_RUNTIME_V2_ENABLED = parseBooleanFlag(import.meta.env.VITE_AGENT_RUNTIME_V2)
