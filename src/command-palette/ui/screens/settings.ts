import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'
import { ScopeScreen } from './scope.js'

export class SettingsScreen implements PaletteScreen {
  readonly id = 'settings'
  readonly breadcrumb = 'Settings'
  readonly placeholder = 'Search settings...'
  readonly emptyText = 'No settings found'
  readonly hints = [
    { key: 'Enter', label: 'edit' },
    { key: 'Esc', label: 'back' },
    { key: '\u2191\u2193', label: 'navigate' },
  ]
  readonly searchIsFilter = true
  readonly navigable = true

  private readonly bridge: CommandPaletteBridge
  private cachedItems: CommandPaletteItem[] = []

  constructor(bridge: CommandPaletteBridge) {
    this.bridge = bridge
  }

  async getItems(): Promise<CommandPaletteItem[]> {
    try {
      this.cachedItems = await this.bridge.listSettings()
    } catch (error) {
      console.error('Failed to list settings:', error)
      this.cachedItems = []
    }
    return this.cachedItems
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    const item = ctx.selectedItem
    if (!item || item.action.type !== 'edit-setting') return { type: 'none' }

    return {
      type: 'push',
      screen: new ScopeScreen(this.bridge, {
        key: item.action.settingKey,
        label: item.action.settingLabel,
        type: item.settingType || 'string',
        currentValue: item.settingValue || '',
        description: item.subtitle || '',
        hasAgentOverride: item.settingSource === 'agent',
      }),
    }
  }

  onExternalUpdate(detail: { key: string; value: unknown }): void {
    for (const item of this.cachedItems) {
      if (item.action.type === 'edit-setting' && item.action.settingKey === detail.key) {
        item.settingValue = detail.value !== undefined ? String(detail.value) : ''
      }
    }
  }
}
