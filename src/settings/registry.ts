export type SettingType = 'string' | 'number' | 'boolean'

export interface SettingDefinition {
  key: string
  label: string
  type: SettingType
  defaultValue: unknown
  description: string
  validate?: (value: unknown) => string | null
}

export const SETTINGS: SettingDefinition[] = [
  {
    key: 'httpApi.port',
    label: 'HTTP API Port',
    type: 'number',
    defaultValue: 9877,
    description: 'Port for the local HTTP API server',
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Must be 1–65535'
      return null
    },
  },
  {
    key: 'httpApi.apiKey',
    label: 'HTTP API Key',
    type: 'string',
    defaultValue: '',
    description: 'Bearer token for HTTP API authentication (auto-generated if empty)',
  },
]
