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
    key: 'backup.intervalHours',
    label: 'Backup Interval (hours)',
    type: 'number',
    defaultValue: 24,
    description: 'How often to automatically back up agent.db (in hours)',
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 8760) return 'Must be 1–8760'
      return null
    },
  },
  {
    key: 'backup.maxCount',
    label: 'Max Backup Count',
    type: 'number',
    defaultValue: 5,
    description: 'Maximum number of backups to keep per agent',
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 100) return 'Must be 1–100'
      return null
    },
  },
]
