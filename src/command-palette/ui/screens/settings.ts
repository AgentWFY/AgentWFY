import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'
import { EditingScreen } from './editing.js'

interface SettingsScreenConfig {
  id: string
  breadcrumb: string
  placeholder: string
  emptyText: string
  listFn: (bridge: CommandPaletteBridge) => Promise<CommandPaletteItem[]>
  isAgentSetting?: boolean
}

function createSettingsScreen(config: SettingsScreenConfig) {
  return class implements PaletteScreen {
    readonly id = config.id
    readonly breadcrumb = config.breadcrumb
    readonly placeholder = config.placeholder
    readonly emptyText = config.emptyText
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
        this.cachedItems = await config.listFn(this.bridge)
      } catch (error) {
        console.error(`Failed to list ${config.id}:`, error)
        this.cachedItems = []
      }
      return this.cachedItems
    }

    async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
      const item = ctx.selectedItem
      if (!item || item.action.type !== 'edit-setting') return { type: 'none' }

      return {
        type: 'push',
        screen: new EditingScreen(this.bridge, {
          key: item.action.settingKey,
          label: item.action.settingLabel,
          type: item.settingType || 'string',
          currentValue: item.settingValue || '',
          description: item.subtitle || '',
          isAgentSetting: config.isAgentSetting,
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
}

export const SettingsScreen = createSettingsScreen({
  id: 'settings',
  breadcrumb: 'Settings',
  placeholder: 'Search settings...',
  emptyText: 'No settings found',
  listFn: (bridge) => bridge.listSettings(),
})

export const AgentSettingsScreen = createSettingsScreen({
  id: 'agent-settings',
  breadcrumb: 'Agent Settings',
  placeholder: 'Search agent settings...',
  emptyText: 'No agent settings found',
  listFn: (bridge) => bridge.listAgentSettings(),
  isAgentSetting: true,
})
