/**
 * OpenAI Codex OAuth flow (ChatGPT Plus/Pro subscription).
 * Moved from pi_ai_browser.ts with PKCE updated to own implementation.
 */
import type { OAuthCallbacks, OAuthCredentials, OAuthProvider } from './types.js'
import { generatePKCE } from './pkce.js'
import { createRandomHex, decodeJwt, parseAuthorizationInput } from './utils.js'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPE = 'openid profile email offline_access'

function getAccountId(token: string): string | null {
  const payload = decodeJwt(token)
  const authClaims = payload?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined
  const accountId = authClaims?.chatgpt_account_id
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
}

function toCredentials(payload: unknown): OAuthCredentials {
  const p = payload as Record<string, unknown> | null
  if (!p?.access_token || !p?.refresh_token || typeof p.expires_in !== 'number') {
    throw new Error('OpenAI Codex token response missing required fields')
  }

  const access = p.access_token as string
  const accountId = getAccountId(access)
  if (!accountId) {
    throw new Error('Failed to extract account ID from OpenAI Codex token')
  }

  return {
    access,
    refresh: p.refresh_token as string,
    expires: Date.now() + (p.expires_in as number) * 1000,
    accountId,
  }
}

async function exchangeCode(code: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`)
  }

  return toCredentials(await response.json())
}

async function refreshCodexToken(refreshTokenValue: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenValue,
      client_id: CLIENT_ID,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`)
  }

  return toCredentials(await response.json())
}

async function login(callbacks: OAuthCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE()
  const state = createRandomHex(16)

  const authUrl = new URL(AUTHORIZE_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('scope', SCOPE)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('originator', 'pi')

  callbacks.onAuth({
    url: authUrl.toString(),
    instructions: 'After login, copy the full localhost callback URL from your browser address bar and paste it here.',
  })
  callbacks.onProgress?.('Waiting for authorization code...')

  const input = await callbacks.onPrompt({
    message: 'Paste the authorization code (or full redirect URL):',
  })
  const parsed = parseAuthorizationInput(input)

  if (parsed.state && parsed.state !== state) {
    throw new Error('OpenAI Codex login failed: state mismatch')
  }

  if (!parsed.code) {
    throw new Error('OpenAI Codex login failed: missing authorization code')
  }

  callbacks.onProgress?.('Exchanging authorization code...')
  return exchangeCode(parsed.code, verifier)
}

export const codexOAuthProvider: OAuthProvider = {
  id: 'openai-codex',
  name: 'ChatGPT Plus/Pro (Codex Subscription)',
  login,
  async refreshToken(credentials) {
    return refreshCodexToken(credentials.refresh)
  },
  getApiKey(credentials) {
    return credentials.access
  },
}
