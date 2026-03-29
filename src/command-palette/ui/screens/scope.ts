import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'
import { EditingScreen } from './editing.js'

interface ScopeParams {
  key: string
  label: string
  type: string
  currentValue: string
  description: string
  hasAgentOverride: boolean
}

export class ScopeScreen implements PaletteScreen {
  readonly id = 'scope'
  readonly breadcrumb: string
  readonly placeholder = 'Select scope\u2026'
  readonly emptyText = 'No options'
  readonly hints = [
    { key: 'Enter', label: 'select' },
    { key: 'Esc', label: 'back' },
    { key: '\u2191\u2193', label: 'navigate' },
  ]
  readonly searchIsFilter = false
  readonly navigable = true

  private readonly bridge: CommandPaletteBridge
  private readonly params: ScopeParams

  constructor(bridge: CommandPaletteBridge, params: ScopeParams) {
    this.bridge = bridge
    this.params = params
    this.breadcrumb = `Settings \u203A ${params.label}`
  }

  getItems(): CommandPaletteItem[] {
    const items: CommandPaletteItem[] = [
      {
        id: 'scope:agent',
        title: 'Set for this agent',
        group: 'Scope',
        action: { type: 'edit-setting', settingKey: this.params.key, settingLabel: this.params.label },
      },
      {
        id: 'scope:global',
        title: 'Set globally',
        group: 'Scope',
        action: { type: 'edit-setting', settingKey: this.params.key, settingLabel: this.params.label },
      },
    ]

    if (this.params.hasAgentOverride) {
      items.push({
        id: 'scope:clear',
        title: 'Clear agent override',
        group: 'Scope',
        action: { type: 'edit-setting', settingKey: this.params.key, settingLabel: this.params.label },
      })
    }

    return items
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    if (!ctx.selectedItem) return { type: 'none' }

    if (ctx.selectedItem.id === 'scope:clear') {
      await this.bridge.clearAgentOverride(this.params.key)
      return { type: 'pop' }
    }

    const scope: 'agent' | 'global' = ctx.selectedItem.id === 'scope:agent' ? 'agent' : 'global'

    return {
      type: 'push',
      screen: new EditingScreen(this.bridge, {
        key: this.params.key,
        label: this.params.label,
        type: this.params.type,
        currentValue: this.params.currentValue,
        description: this.params.description,
        scope,
      }),
    }
  }

  async onClick(ctx: { item: CommandPaletteItem; index: number }): Promise<ScreenResult> {
    return this.onEnter({ selectedItem: ctx.item, searchValue: '', selectedIndex: ctx.index })
  }
}
