import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

export class PluginsScreen implements PaletteScreen {
  readonly id = 'plugins'
  readonly breadcrumb = 'Plugins'
  readonly placeholder = 'Search plugins...'
  readonly emptyText = 'No plugins installed'
  readonly hints = [
    { key: 'Enter', label: 'select' },
    { key: 'Esc', label: 'back' },
    { key: '\u2191\u2193', label: 'navigate' },
  ]
  readonly searchIsFilter = true
  readonly navigable = true

  private readonly bridge: CommandPaletteBridge

  constructor(bridge: CommandPaletteBridge) {
    this.bridge = bridge
  }

  async getItems(): Promise<CommandPaletteItem[]> {
    try {
      return await this.bridge.listPlugins()
    } catch (error) {
      console.error('Failed to list plugins:', error)
      return []
    }
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    const item = ctx.selectedItem
    if (!item) return { type: 'none' }

    if (item.action.type === 'install-plugin') {
      return { type: 'action', action: item.action }
    }

    if (item.action.type === 'toggle-plugin') {
      const action = item.action as { type: 'toggle-plugin'; pluginName: string; enabled: boolean }
      // action.enabled is the target toggle state, so current state is the inverse
      return {
        type: 'push',
        screen: new PluginDetailScreen(this.bridge, action.pluginName, !action.enabled),
      }
    }

    return { type: 'none' }
  }
}

class PluginDetailScreen implements PaletteScreen {
  readonly id = 'plugin-detail'
  readonly breadcrumb: string
  readonly placeholder = ''
  readonly emptyText = ''
  readonly hints = [
    { key: 'Enter', label: 'run' },
    { key: 'Esc', label: 'back' },
  ]
  readonly searchIsFilter = true
  readonly navigable = true

  private readonly bridge: CommandPaletteBridge
  private readonly pluginName: string
  private readonly enabled: boolean

  constructor(bridge: CommandPaletteBridge, pluginName: string, enabled: boolean) {
    this.bridge = bridge
    this.pluginName = pluginName
    this.enabled = enabled
    this.breadcrumb = pluginName
  }

  getItems(): CommandPaletteItem[] {
    return [
      {
        id: 'plugin-action:toggle',
        title: this.enabled ? 'Disable' : 'Enable',
        group: 'Plugins',
        action: { type: 'toggle-plugin', pluginName: this.pluginName, enabled: !this.enabled },
      },
      {
        id: 'plugin-action:uninstall',
        title: 'Uninstall',
        group: 'Plugins',
        action: { type: 'toggle-plugin', pluginName: this.pluginName, enabled: false },
      },
    ]
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    const item = ctx.selectedItem
    if (!item) return { type: 'none' }

    if (item.id === 'plugin-action:toggle') {
      try {
        await this.bridge.togglePlugin(this.pluginName, !this.enabled)
      } catch (error) {
        console.error('Failed to toggle plugin:', error)
      }
      return { type: 'pop' }
    }

    if (item.id === 'plugin-action:uninstall') {
      try {
        await this.bridge.uninstallPlugin(this.pluginName)
      } catch (error) {
        console.error('Failed to uninstall plugin:', error)
      }
      return { type: 'pop' }
    }

    return { type: 'none' }
  }
}
