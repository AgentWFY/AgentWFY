import {
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
} from '@mariozechner/pi-ai'
import type { OAuthCredentials, OAuthProviderInterface, OAuthLoginCallbacks } from '@mariozechner/pi-ai'
import { requireClientTools } from 'app/agent/tool_utils'

export type AuthMethod = 'api-key' | 'oauth-anthropic' | 'oauth-github-copilot'

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
}

function getClientTools() {
  const tools = requireClientTools()

  if (
    typeof tools.readAuthConfig !== 'function'
    || typeof tools.writeAuthConfig !== 'function'
    || typeof tools.readLegacyApiKey !== 'function'
  ) {
    throw new Error('Electron auth storage methods are not available')
  }

  return tools
}

export async function loadAuthConfig(): Promise<AgentAuthConfig> {
  const tools = getClientTools()

  try {
    const raw = await tools.readAuthConfig()
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    // Config doesn't exist yet — check for legacy api_key file
  }

  try {
    const legacyKey = await tools.readLegacyApiKey()
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
  const tools = getClientTools()
  await tools.writeAuthConfig(JSON.stringify(config, null, 2))
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
    default: return ''
  }
}

export function getAvailableOAuthProviders(): { id: AuthMethod; name: string }[] {
  return [
    { id: 'oauth-anthropic', name: 'Anthropic (Claude Pro/Max)' },
    { id: 'oauth-github-copilot', name: 'GitHub Copilot' },
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
