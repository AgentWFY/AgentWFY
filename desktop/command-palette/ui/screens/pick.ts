import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

export interface PickScreenParams {
  title?: string
  placeholder?: string
}

export class PickScreen implements PaletteScreen {
  readonly id = 'pick'
  readonly breadcrumb: string
  readonly placeholder: string
  readonly emptyText = 'No items'
  readonly hints = [
    { key: 'Enter', label: 'pick' },
    { key: 'Esc', label: 'cancel' },
    { key: '↑↓', label: 'navigate' },
  ]
  readonly searchIsFilter = true
  readonly navigable = true

  private readonly bridge: CommandPaletteBridge

  constructor(bridge: CommandPaletteBridge, params?: PickScreenParams) {
    this.bridge = bridge
    this.breadcrumb = (params?.title && params.title.trim()) || 'Pick'
    this.placeholder = (params?.placeholder && params.placeholder.trim()) || 'Filter…'
  }

  async getItems(): Promise<CommandPaletteItem[]> {
    try {
      return await this.bridge.listPickItems()
    } catch (error) {
      console.error('Failed to list pick items:', error)
      return []
    }
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null }): Promise<ScreenResult> {
    const action = ctx.selectedItem?.action
    if (!action || action.type !== 'pick-item') return { type: 'none' }
    await this.bridge.resolvePick(action.index)
    return { type: 'none' }
  }
}
