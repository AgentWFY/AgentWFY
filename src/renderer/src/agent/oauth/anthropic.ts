/**
 * Anthropic OAuth flow (Claude Pro/Max subscription).
 * Matches the flow from @mariozechner/pi-ai.
 */
import type { OAuthCallbacks, OAuthCredentials, OAuthProvider } from './types'
import { generatePKCE } from './pkce'
import { parseAuthorizationInput } from './utils'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference'

function toCredentials(payload: unknown): OAuthCredentials {
  const p = payload as Record<string, unknown> | null
  if (!p?.access_token || !p?.refresh_token || typeof p.expires_in !== 'number') {
    throw new Error('Anthropic token response missing required fields')
  }

  return {
    access: p.access_token as string,
    refresh: p.refresh_token as string,
    expires: Date.now() + (p.expires_in as number) * 1000 - 5 * 60 * 1000,
  }
}

async function exchangeCode(code: string, state: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Anthropic token exchange failed (${response.status}): ${text || response.statusText}`)
  }

  return toCredentials(await response.json())
}

async function refreshToken(refreshTokenValue: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshTokenValue,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Anthropic token refresh failed (${response.status}): ${text || response.statusText}`)
  }

  return toCredentials(await response.json())
}

async function login(callbacks: OAuthCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE()

  const authUrl = new URL(AUTHORIZE_URL)
  authUrl.searchParams.set('code', 'true')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', verifier)

  callbacks.onAuth({
    url: authUrl.toString(),
    instructions: 'After login, paste the authorization code (format: code#state).',
  })
  callbacks.onProgress?.('Waiting for authorization code...')

  const input = await callbacks.onPrompt({
    message: 'Paste the authorization code:',
  })
  const parsed = parseAuthorizationInput(input)

  if (!parsed.code) {
    throw new Error('Anthropic login failed: missing authorization code')
  }

  callbacks.onProgress?.('Exchanging authorization code...')
  return exchangeCode(parsed.code, parsed.state ?? '', verifier)
}

export const anthropicOAuthProvider: OAuthProvider = {
  id: 'anthropic',
  name: 'Anthropic (Claude Pro/Max)',
  login,
  async refreshToken(credentials) {
    return refreshToken(credentials.refresh)
  },
  getApiKey(credentials) {
    return credentials.access
  },
}
