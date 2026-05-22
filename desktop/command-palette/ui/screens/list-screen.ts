import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

interface ListScreenConfig {
  id: string
  breadcrumb: string
  placeholder: string
  emptyText: string
  enterLabel: string
  listFn: (bridge: CommandPaletteBridge) => Promise<CommandPaletteItem[]>
}

export function createListScreen(config: ListScreenConfig) {
  return class implements PaletteScreen {
    readonly id = config.id
    readonly breadcrumb = config.breadcrumb
    readonly placeholder = config.placeholder
    readonly emptyText = config.emptyText
    readonly hints = [
      { key: 'Enter', label: config.enterLabel },
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
        return await config.listFn(this.bridge)
      } catch (error) {
        console.error(`Failed to list ${config.id} items:`, error)
        return []
      }
    }

    async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
      if (!ctx.selectedItem) return { type: 'none' }
      return { type: 'action', action: ctx.selectedItem.action }
    }
  }
}
