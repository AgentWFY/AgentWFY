/**
 * Browser-only shim for `@mariozechner/pi-ai`.
 *
 * Why this exists:
 * - `@mariozechner/pi-agent-core` imports `@mariozechner/pi-ai` top-level.
 * - The top-level `pi-ai` entry re-exports all built-in providers, including
 *   Bedrock/AWS providers that pull Node-only dependencies.
 * - In this Vite renderer build, that causes production build failures such as:
 *   "Readable is not exported by __vite-browser-external"
 *   (from @smithy/node-http-handler / stream).
 *
 * This shim exports only the browser-safe pieces used by this app and wires
 * `stream`/`streamSimple` to OpenAI-compatible providers.
 *
 * Removal criteria:
 * - Remove this file + the alias in `vite.config.js` once our toolchain and
 *   upstream packages can build the renderer without pulling Node-only providers.
 */
import { Type } from '@sinclair/typebox'
import { getModel, getModels, getProviders, calculateCost, supportsXhigh, modelsAreEqual } from '@mariozechner/pi-ai/dist/models.js'
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from '@mariozechner/pi-ai/dist/providers/openai-completions.js'
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from '@mariozechner/pi-ai/dist/providers/openai-responses.js'
import { streamOpenAICodexResponses, streamSimpleOpenAICodexResponses } from '@mariozechner/pi-ai/dist/providers/openai-codex-responses.js'
import { streamAnthropic, streamSimpleAnthropic } from '@mariozechner/pi-ai/dist/providers/anthropic.js'
import { EventStream, AssistantMessageEventStream, createAssistantMessageEventStream } from '@mariozechner/pi-ai/dist/utils/event-stream.js'
import { parseStreamingJson } from '@mariozechner/pi-ai/dist/utils/json-parse.js'
import { isContextOverflow } from '@mariozechner/pi-ai/dist/utils/overflow.js'
import { validateToolArguments, validateToolCall } from '@mariozechner/pi-ai/dist/utils/validation.js'
import { anthropicOAuthProvider, refreshAnthropicToken, loginAnthropic } from '@mariozechner/pi-ai/dist/utils/oauth/anthropic.js'
import { githubCopilotOAuthProvider, refreshGitHubCopilotToken, loginGitHubCopilot } from '@mariozechner/pi-ai/dist/utils/oauth/github-copilot.js'
import { generatePKCE } from '@mariozechner/pi-ai/dist/utils/oauth/pkce.js'
import type { OAuthCredentials, OAuthProviderInterface, OAuthLoginCallbacks } from '@mariozechner/pi-ai/dist/utils/oauth/types.js'

type AnyModel = any
type AnyContext = any
type AnyOptions = any

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const OPENAI_CODEX_SCOPE = 'openid profile email offline_access'

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}

  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // Not a URL, keep parsing.
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

function createRandomHex(bytes: number): string {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')
}

function decodeJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) return null
    const payloadJson = atob(parts[1])
    return JSON.parse(payloadJson)
  } catch {
    return null
  }
}

function getOpenAICodexAccountId(token: string): string | null {
  const payload = decodeJwt(token)
  const authClaims = payload?.['https://api.openai.com/auth']
  const accountId = authClaims?.chatgpt_account_id
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
}

function toOpenAICodexCredentials(payload: any): OAuthCredentials {
  if (!payload?.access_token || !payload?.refresh_token || typeof payload.expires_in !== 'number') {
    throw new Error('OpenAI Codex token response missing required fields')
  }

  const access = payload.access_token
  const accountId = getOpenAICodexAccountId(access)
  if (!accountId) {
    throw new Error('Failed to extract account ID from OpenAI Codex token')
  }

  return {
    access,
    refresh: payload.refresh_token,
    expires: Date.now() + payload.expires_in * 1000,
    accountId,
  }
}

async function exchangeOpenAICodexCode(code: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`)
  }

  const json = await response.json()
  return toOpenAICodexCredentials(json)
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`)
  }

  const json = await response.json()
  return toOpenAICodexCredentials(json)
}

export async function loginOpenAICodex(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE()
  const state = createRandomHex(16)

  const authUrl = new URL(OPENAI_CODEX_AUTHORIZE_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', OPENAI_CODEX_REDIRECT_URI)
  authUrl.searchParams.set('scope', OPENAI_CODEX_SCOPE)
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
  return exchangeOpenAICodexCode(parsed.code, verifier)
}

export const openaiCodexOAuthProvider: OAuthProviderInterface = {
  id: 'openai-codex',
  name: 'ChatGPT Plus/Pro (Codex Subscription)',
  usesCallbackServer: false,
  login: loginOpenAICodex,
  async refreshToken(credentials) {
    return refreshOpenAICodexToken(credentials.refresh)
  },
  getApiKey(credentials) {
    return credentials.access
  },
}

function noProviderError(api: string): never {
  throw new Error(`No API provider registered for api: ${api}. This browser build supports openai-completions, openai-responses, openai-codex-responses, and anthropic-messages.`)
}

export function stream(model: AnyModel, context: AnyContext, options?: AnyOptions) {
  if (model.api === 'openai-completions') {
    return streamOpenAICompletions(model, context, options)
  }

  if (model.api === 'openai-responses') {
    return streamOpenAIResponses(model, context, options)
  }

  if (model.api === 'openai-codex-responses') {
    return streamOpenAICodexResponses(model, context, options)
  }

  if (model.api === 'anthropic-messages') {
    return streamAnthropic(model, context, options)
  }

  return noProviderError(model.api)
}

export function streamSimple(model: AnyModel, context: AnyContext, options?: AnyOptions) {
  if (model.api === 'openai-completions') {
    return streamSimpleOpenAICompletions(model, context, options)
  }

  if (model.api === 'openai-responses') {
    return streamSimpleOpenAIResponses(model, context, options)
  }

  if (model.api === 'openai-codex-responses') {
    return streamSimpleOpenAICodexResponses(model, context, options)
  }

  if (model.api === 'anthropic-messages') {
    return streamSimpleAnthropic(model, context, options)
  }

  return noProviderError(model.api)
}

export async function complete(model: AnyModel, context: AnyContext, options?: AnyOptions) {
  const result = stream(model, context, options)
  return result.result()
}

export async function completeSimple(model: AnyModel, context: AnyContext, options?: AnyOptions) {
  const result = streamSimple(model, context, options)
  return result.result()
}

export {
  Type,
  getModel,
  getModels,
  getProviders,
  calculateCost,
  supportsXhigh,
  modelsAreEqual,
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
  parseStreamingJson,
  isContextOverflow,
  validateToolArguments,
  validateToolCall,
  // Anthropic streaming
  streamAnthropic,
  streamSimpleAnthropic,
  // OpenAI Codex streaming
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
  // OAuth providers
  anthropicOAuthProvider,
  refreshAnthropicToken,
  loginAnthropic,
  githubCopilotOAuthProvider,
  refreshGitHubCopilotToken,
  loginGitHubCopilot,
}

export type {
  OAuthCredentials,
  OAuthProviderInterface,
  OAuthLoginCallbacks,
}
