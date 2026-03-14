import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

export class RestoreScreen implements PaletteScreen {
  readonly id = 'restore'
  readonly breadcrumb = 'Restore Agent Database'
  readonly placeholder = 'Select backup to restore...'
  readonly emptyText = 'No backups found'
  readonly hints = [
    { key: 'Enter', label: 'restore' },
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
      return await this.bridge.listBackups()
    } catch (error) {
      console.error('Failed to list backups:', error)
      return []
    }
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    if (!ctx.selectedItem) return { type: 'none' }
    return { type: 'action', action: ctx.selectedItem.action }
  }
}
