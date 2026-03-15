import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

export interface EditingParams {
  key: string
  label: string
  type: string
  currentValue: string
  description: string
  scope: 'agent' | 'global'
}

export class EditingScreen implements PaletteScreen {
  readonly id = 'editing'
  readonly breadcrumb: string
  readonly emptyText = 'No matches'
  readonly hints = [
    { key: 'Enter', label: 'save' },
    { key: 'Esc', label: 'back' },
  ]
  readonly searchIsFilter = false

  private readonly bridge: CommandPaletteBridge
  private readonly params: EditingParams
  private error = ''

  get placeholder(): string {
    return this.params.type === 'boolean' ? 'Select value...' : this.params.label
  }

  get navigable(): boolean {
    return this.params.type === 'boolean'
  }

  get initialSearchValue(): string | undefined {
    return this.params.type === 'boolean' ? undefined : this.params.currentValue
  }

  get initialSelectedIndex(): number | undefined {
    if (this.params.type === 'boolean') {
      return this.params.currentValue === 'true' ? 0 : 1
    }
    return undefined
  }

  constructor(bridge: CommandPaletteBridge, params: EditingParams) {
    this.bridge = bridge
    this.params = params
    const scopeLabel = params.scope === 'agent' ? 'Agent' : 'Global'
    this.breadcrumb = `Settings \u203A ${params.label} (${scopeLabel})`
  }

  getItems(): CommandPaletteItem[] {
    if (this.params.type !== 'boolean') return []

    return [
      {
        id: 'bool:true',
        title: 'true',
        group: 'Settings',
        action: { type: 'edit-setting', settingKey: this.params.key, settingLabel: this.params.label },
        settingValue: this.params.currentValue === 'true' ? 'current' : undefined,
      },
      {
        id: 'bool:false',
        title: 'false',
        group: 'Settings',
        action: { type: 'edit-setting', settingKey: this.params.key, settingLabel: this.params.label },
        settingValue: this.params.currentValue === 'false' ? 'current' : undefined,
      },
    ]
  }

  renderContent(container: HTMLElement): void {
    if (this.params.type === 'boolean') return

    const descEl = document.createElement('div')
    descEl.className = 'edit-description'
    descEl.textContent = this.params.description
    container.appendChild(descEl)

    if (this.error) {
      const errorEl = document.createElement('div')
      errorEl.className = 'edit-error'
      errorEl.textContent = this.error
      container.appendChild(errorEl)
    }
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    this.error = ''
    let value: unknown

    if (this.params.type === 'boolean') {
      value = ctx.selectedIndex === 0
    } else {
      value = ctx.searchValue
    }

    try {
      const result = await this.bridge.updateSetting(this.params.key, value, this.params.scope)
      if (result.success) {
        return { type: 'pop' }
      }
      this.error = result.error || 'Failed to save'
      return { type: 'none' }
    } catch {
      this.error = 'Failed to save setting'
      return { type: 'none' }
    }
  }

  async onClick(ctx: { item: CommandPaletteItem; index: number }): Promise<ScreenResult> {
    if (this.params.type === 'boolean') {
      return this.onEnter({ selectedItem: ctx.item, searchValue: '', selectedIndex: ctx.index })
    }
    return { type: 'none' }
  }

  onExternalUpdate(detail: { key: string; value: unknown }): void {
    if (detail.key === this.params.key) {
      this.params.currentValue = detail.value !== undefined ? String(detail.value) : ''
    }
  }
}
