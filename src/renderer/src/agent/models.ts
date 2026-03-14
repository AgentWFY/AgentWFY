import type { ApiType, AuthType, Model, Provider } from './types.js'

// ── Config schema (matches .agentwfy/models.json) ──

export interface ModelConfig {
  id: string
  name: string
  reasoning?: boolean
}

export interface ProviderConfig {
  name: string
  baseUrl: string
  api: ApiType
  auth: AuthType
  models: ModelConfig[]
}

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>
}

// ── Default config (shipped with app, copied to .agentwfy/models.json on first run) ──

export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  providers: {
    openrouter: {
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api',
      api: 'openai-completions',
      auth: 'api-key',
      models: [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', reasoning: true },
        { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', reasoning: true },
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', reasoning: true },
        { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5', reasoning: true },
        { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', reasoning: true },
        { id: 'openai/gpt-5-codex', name: 'GPT-5 Codex', reasoning: true },
        { id: 'openai/gpt-5', name: 'GPT-5', reasoning: true },
        { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', reasoning: true },
        { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5' },
      ],
    },
    anthropic: {
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      api: 'anthropic-messages',
      auth: 'oauth-anthropic',
      models: [
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true },
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true },
        { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', reasoning: true },
        { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4', reasoning: true },
        { id: 'claude-opus-4-0', name: 'Claude Opus 4', reasoning: true },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: true },
        { id: 'claude-3-7-sonnet-latest', name: 'Claude Sonnet 3.7', reasoning: true },
        { id: 'claude-3-5-haiku-latest', name: 'Claude Haiku 3.5' },
      ],
    },
    'openai-codex': {
      name: 'OpenAI Codex',
      baseUrl: 'https://api.openai.com',
      api: 'openai-codex-responses',
      auth: 'oauth-openai-codex',
      models: [
        { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true },
        { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoning: true },
        { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', reasoning: true },
        { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', reasoning: true },
        { id: 'gpt-5.2', name: 'GPT-5.2', reasoning: true },
        { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', reasoning: true },
        { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', reasoning: true },
        { id: 'gpt-5.1', name: 'GPT-5.1', reasoning: true },
      ],
    },
  },
}

// ── Config loader ──

let cachedConfig: ModelsConfig | null = null

export async function loadModelsConfig(): Promise<ModelsConfig> {
  if (cachedConfig) return cachedConfig

  try {
    const ipc = window.ipc
    if (ipc) {
      const raw = await ipc.files.read('.agentwfy/models.json')
      cachedConfig = JSON.parse(raw) as ModelsConfig
      return cachedConfig
    }
  } catch {
    // File doesn't exist yet or parse error — use default
  }

  cachedConfig = DEFAULT_MODELS_CONFIG
  return cachedConfig
}

export function getModelsConfigSync(): ModelsConfig {
  return cachedConfig ?? DEFAULT_MODELS_CONFIG
}

// ── Accessors ──

function buildProvider(id: string, pc: ProviderConfig): Provider {
  return {
    id,
    name: pc.name,
    baseUrl: pc.baseUrl,
    api: pc.api,
    auth: pc.auth,
  }
}

export function getProviderIds(config?: ModelsConfig): string[] {
  const c = config ?? getModelsConfigSync()
  return Object.keys(c.providers)
}

export function getModels(config: ModelsConfig | undefined, providerId: string): Model[] {
  const c = config ?? getModelsConfigSync()
  const pc = c.providers[providerId]
  if (!pc) return []

  const provider = buildProvider(providerId, pc)
  return pc.models.map((mc) => ({
    id: mc.id,
    name: mc.name,
    reasoning: mc.reasoning ?? false,
    provider,
  }))
}

export function getModel(config: ModelsConfig | undefined, providerId: string, modelId: string): Model | undefined {
  return getModels(config, providerId).find((m) => m.id === modelId)
}
