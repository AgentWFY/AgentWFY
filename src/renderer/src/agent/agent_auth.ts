/* eslint-disable import/no-unresolved */
import {
  anthropicOAuthProvider,
  getModels,
  githubCopilotOAuthProvider,
  openaiCodexOAuthProvider,
} from '@mariozechner/pi-ai'
import type { OAuthCredentials, OAuthProviderInterface, OAuthLoginCallbacks } from '@mariozechner/pi-ai'
import { requireIpc } from 'app/agent/tool_utils'

export type AuthMethod = 'api-key' | 'oauth-anthropic' | 'oauth-github-copilot' | 'oauth-openai-codex'

export interface AgentAuthConfig {
  authMethod: AuthMethod
  apiKey?: string
  oauthCredentials: Record<string, OAuthCredentials>
  provider: string
  modelId: string
  thinkingLevel: string
}

const DEFAULT_CONFIG: AgentAuthConfig = {
  authMethod: 'api-key',
  apiKey: undefined,
  oauthCredentials: {},
  provider: 'openrouter',
  modelId: 'moonshotai/kimi-k2.5',
  thinkingLevel: 'off',
}

const OAUTH_PROVIDERS: Record<string, OAuthProviderInterface> = {
  'oauth-anthropic': anthropicOAuthProvider,
  'oauth-github-copilot': githubCopilotOAuthProvider,
  'oauth-openai-codex': openaiCodexOAuthProvider,
}

const AUTH_METHODS: AuthMethod[] = ['api-key', 'oauth-anthropic', 'oauth-github-copilot', 'oauth-openai-codex']

function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === 'string' && AUTH_METHODS.includes(value as AuthMethod)
}

function sortModelsForProvider(provider: string, models: Array<{ id?: string }>) {
  if (provider === 'openai-codex') {
    return [...models].sort((a, b) =>
      String(b?.id ?? '').localeCompare(String(a?.id ?? ''), undefined, { numeric: true, sensitivity: 'base' })
    )
  }

  return models
}

function safeGetModels(provider: string): Array<{ id?: string }> {
  try {
    return sortModelsForProvider(provider, getModels(provider as never) as Array<{ id?: string }>)
  } catch {
    return []
  }
}

function getModelIdForProvider(provider: string, currentModelId: string): string {
  const models = safeGetModels(provider)
  if (models.some((model) => model.id === currentModelId)) {
    return currentModelId
  }
  return models.length > 0 ? String(models[0].id ?? '') : currentModelId
}

function normalizePartialConfig(config: Partial<AgentAuthConfig>): AgentAuthConfig {
  const authMethod = isAuthMethod(config.authMethod) ? config.authMethod : DEFAULT_CONFIG.authMethod
  const providerOverride = getProviderForAuthMethod(authMethod)
  const provider = providerOverride || config.provider || DEFAULT_CONFIG.provider
  const candidateModelId =
    typeof config.modelId === 'string' && config.modelId.trim().length > 0
      ? config.modelId
      : DEFAULT_CONFIG.modelId
  const modelId = getModelIdForProvider(provider, candidateModelId)

  const oauthCredentials = (config.oauthCredentials && typeof config.oauthCredentials === 'object')
    ? config.oauthCredentials
    : {}

  return {
    authMethod,
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : undefined,
    oauthCredentials,
    provider,
    modelId,
    thinkingLevel: typeof config.thinkingLevel === 'string' ? config.thinkingLevel : DEFAULT_CONFIG.thinkingLevel,
  }
}

function configHash(config: AgentAuthConfig): string {
  return JSON.stringify(config)
}

export function normalizeAuthConfig(config: AgentAuthConfig): AgentAuthConfig {
  return normalizePartialConfig(config)
}

function getAuthApi() {
  return requireIpc().auth
}

export async function loadAuthConfig(): Promise<AgentAuthConfig> {
  const auth = getAuthApi()

  try {
    const raw = await auth.readConfig()
    const parsed = JSON.parse(raw)
    const merged = { ...DEFAULT_CONFIG, ...parsed }
    const normalized = normalizePartialConfig(merged)
    if (configHash(normalized) !== configHash(merged)) {
      await saveAuthConfig(normalized)
    }
    return normalized
  } catch {
    // Config doesn't exist yet — check for legacy api_key file
  }

  try {
    const legacyKey = await auth.readLegacyKey()
    const trimmed = legacyKey?.trim()
    if (trimmed) {
      const config: AgentAuthConfig = {
        ...DEFAULT_CONFIG,
        authMethod: 'api-key',
        apiKey: trimmed,
      }
      await saveAuthConfig(config)
      return config
    }
  } catch {
    // No legacy key either
  }

  return { ...DEFAULT_CONFIG }
}

export async function saveAuthConfig(config: AgentAuthConfig): Promise<void> {
  const auth = getAuthApi()
  const normalized = normalizePartialConfig(config)
  await auth.writeConfig(JSON.stringify(normalized, null, 2))
}

export function getOAuthProvider(authMethod: AuthMethod): OAuthProviderInterface | undefined {
  return OAUTH_PROVIDERS[authMethod]
}

export async function getEffectiveApiKey(config: AgentAuthConfig): Promise<string | undefined> {
  if (config.authMethod === 'api-key') {
    return config.apiKey
  }

  const provider = OAUTH_PROVIDERS[config.authMethod]
  if (!provider) return undefined

  const creds = config.oauthCredentials[config.authMethod]
  if (!creds) return undefined

  // Refresh if expired (with 60s buffer)
  if (Date.now() >= creds.expires - 60_000) {
    try {
      const refreshed = await provider.refreshToken(creds)
      config.oauthCredentials[config.authMethod] = refreshed
      await saveAuthConfig(config)
      return provider.getApiKey(refreshed)
    } catch (err) {
      console.error('[agent_auth] Token refresh failed:', err)
      return undefined
    }
  }

  return provider.getApiKey(creds)
}

export function isOAuthConnected(config: AgentAuthConfig): boolean {
  if (config.authMethod === 'api-key') return false
  const creds = config.oauthCredentials[config.authMethod]
  return !!creds?.access
}

export function hasValidAuth(config: AgentAuthConfig): boolean {
  if (config.authMethod === 'api-key') {
    return !!config.apiKey?.trim()
  }
  return isOAuthConnected(config)
}

export function getProviderForAuthMethod(authMethod: AuthMethod): string {
  switch (authMethod) {
    case 'oauth-anthropic': return 'anthropic'
    case 'oauth-github-copilot': return 'github-copilot'
    case 'oauth-openai-codex': return 'openai-codex'
    default: return ''
  }
}

export function getAvailableOAuthProviders(): { id: AuthMethod; name: string }[] {
  return [
    { id: 'oauth-anthropic', name: 'Anthropic (Claude Pro/Max)' },
    { id: 'oauth-github-copilot', name: 'GitHub Copilot' },
    { id: 'oauth-openai-codex', name: 'ChatGPT Plus/Pro (Codex Subscription)' },
  ]
}

export async function performOAuthLogin(
  authMethod: AuthMethod,
  callbacks: OAuthLoginCallbacks
): Promise<OAuthCredentials> {
  const provider = OAUTH_PROVIDERS[authMethod]
  if (!provider) {
    throw new Error(`No OAuth provider for auth method: ${authMethod}`)
  }
  return provider.login(callbacks)
}

export async function logoutOAuth(config: AgentAuthConfig): Promise<AgentAuthConfig> {
  const updated = { ...config, oauthCredentials: { ...config.oauthCredentials } }
  delete updated.oauthCredentials[config.authMethod]
  await saveAuthConfig(updated)
  return updated
}
