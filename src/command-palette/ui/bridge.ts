import type { CommandPaletteAction, CommandPaletteItem } from '../types.js'

export interface CommandPaletteBridge {
  listItems(): Promise<CommandPaletteItem[]>
  runAction(action: CommandPaletteAction): Promise<void>
  close(): Promise<void>
  onOpened(callback: () => void): () => void
  onOpenedWithFilter(callback: (query: string) => void): () => void
  onOpenedAtScreen(callback: (options: { screen: string; params?: Record<string, unknown> }) => void): () => void
  listSettings(): Promise<CommandPaletteItem[]>
  updateSetting(key: string, value: unknown, scope?: 'agent' | 'global'): Promise<{ success: boolean; error?: string }>
  clearAgentOverride(key: string): Promise<void>
  openSettingsFile(): Promise<void>
  listRecentAgents(): Promise<CommandPaletteItem[]>
  listBackups(): Promise<CommandPaletteItem[]>
  listTasks(): Promise<CommandPaletteItem[]>
  listPlugins(): Promise<CommandPaletteItem[]>
  installPlugin(): Promise<{ installed: string[] }>
  uninstallPlugin(pluginName: string): Promise<void>
  togglePlugin(pluginName: string, enabled: boolean): Promise<void>
  onSettingChanged(callback: (detail: { key: string; value: unknown }) => void): () => void
}
