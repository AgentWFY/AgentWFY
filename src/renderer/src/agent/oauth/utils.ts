export function createRandomHex(bytes: number): string {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}

  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // Not a URL
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }

  return { code: value }
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) return null
    const payloadJson = atob(parts[1])
    return JSON.parse(payloadJson)
  } catch {
    return null
  }
}
