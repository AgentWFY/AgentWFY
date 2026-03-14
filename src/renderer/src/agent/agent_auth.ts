import type { OAuthCredentials, OAuthCallbacks, OAuthProvider } from './oauth/types.js'
import { anthropicOAuthProvider } from './oauth/anthropic.js'
import { codexOAuthProvider } from './oauth/codex.js'
import { getModels as getModelsFromConfig, getModelsConfigSync, loadModelsConfig } from './models.js'
import { requireIpc } from './tool_utils.js'

export type AuthMethod = 'api-key' | 'oauth-anthropic' | 'oauth-openai-codex'

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

const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  'oauth-anthropic': anthropicOAuthProvider,
  'oauth-openai-codex': codexOAuthProvider,
}

const AUTH_METHODS: AuthMethod[] = ['api-key', 'oauth-anthropic', 'oauth-openai-codex']

function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === 'string' && AUTH_METHODS.includes(value as AuthMethod)
}

function sortModelsForProvider<T extends { id: string }>(provider: string, models: T[]): T[] {
  if (provider === 'openai-codex') {
    return [...models].sort((a, b) =>
      String(b?.id ?? '').localeCompare(String(a?.id ?? ''), undefined, { numeric: true, sensitivity: 'base' })
    )
  }

  return models
}

export function safeGetModels(provider: string): Array<{ id: string; name: string }> {
  try {
    const config = getModelsConfigSync()
    return sortModelsForProvider(provider, getModelsFromConfig(config, provider))
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

  // Ensure models config is loaded before normalizing, so custom models
  // are visible and don't get treated as invalid during normalization.
  await loadModelsConfig()

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

let refreshLock: Promise<void> | null = null

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
    // Serialize concurrent refresh attempts to avoid race conditions
    if (refreshLock) {
      await refreshLock
      // After waiting, re-check — another caller may have refreshed already
      const updatedCreds = config.oauthCredentials[config.authMethod]
      if (updatedCreds && Date.now() < updatedCreds.expires - 60_000) {
        return provider.getApiKey(updatedCreds)
      }
    }

    let resolveRefresh: () => void
    refreshLock = new Promise((resolve) => { resolveRefresh = resolve })

    try {
      const refreshed = await provider.refreshToken(creds)
      config.oauthCredentials[config.authMethod] = refreshed
      await saveAuthConfig(config)
      return provider.getApiKey(refreshed)
    } catch (err) {
      console.error('[agent_auth] Token refresh failed:', err)
      return undefined
    } finally {
      resolveRefresh!()
      refreshLock = null
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
    case 'oauth-openai-codex': return 'openai-codex'
    default: return ''
  }
}

export function getAvailableOAuthProviders(): { id: AuthMethod; name: string }[] {
  return [
    { id: 'oauth-anthropic', name: 'Anthropic (Claude Pro/Max)' },
    { id: 'oauth-openai-codex', name: 'ChatGPT Plus/Pro (Codex Subscription)' },
  ]
}

export async function performOAuthLogin(
  authMethod: AuthMethod,
  callbacks: OAuthCallbacks
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
