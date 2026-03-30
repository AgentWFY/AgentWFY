import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

type SettingTarget = 'default' | 'global' | 'agent'

interface SettingRow {
  key: string
  label: string
  shortName: string
  description: string
  value: string
  originalValue: string
  originalTarget: SettingTarget
  target: SettingTarget
  group: string
  dirty: boolean
}

interface SettingsGroup {
  prefix: string
  displayName: string
  depth: number
  items: SettingRow[]
  children: SettingsGroup[]
}

const SETTINGS_WIDTH = 720
const SETTINGS_HEIGHT = 700

export class SettingsScreen implements PaletteScreen {
  readonly id = 'settings'
  readonly breadcrumb = 'Settings'
  readonly placeholder = 'Filter settings\u2026'
  readonly emptyText = 'No settings found'
  readonly hints: Array<{ key: string; label: string }> = []
  readonly searchIsFilter = false
  readonly navigable = false

  private readonly bridge: CommandPaletteBridge
  private allRows: SettingRow[] = []
  private rowsByKey = new Map<string, SettingRow>()
  private filteredRows: SettingRow[] = []
  private collapsed = new Set<string>()
  private focusedKey: string | null = null
  private focusCursorPos: number | null = null
  private error = ''
  private saving = false
  private searchValue = ''
  private loaded = false
  private container: HTMLElement | null = null

  constructor(bridge: CommandPaletteBridge) {
    this.bridge = bridge
  }

  onActivate(): void {
    void this.bridge.resize({ width: SETTINGS_WIDTH, height: SETTINGS_HEIGHT })
  }

  onDeactivate(): void {
    void this.bridge.resize({ width: 0, height: 0 })
  }

  async getItems(): Promise<CommandPaletteItem[]> {
    if (!this.loaded) {
      try {
        const items = await this.bridge.listSettings()
        this.allRows = items.map(item => {
          const source = (item.settingSource || 'default') as SettingTarget
          const key = item.action.type === 'edit-setting'
            ? (item.action as { settingKey: string }).settingKey : item.id
          const parts = key.split('.')
          const shortName = parts.length > 2 ? parts.slice(2).join('.') : parts[parts.length - 1]
          return {
            key,
            label: item.title,
            shortName,
            description: item.subtitle || '',
            value: item.settingValue ?? '',
            originalValue: item.settingValue ?? '',
            originalTarget: source,
            target: source,
            group: item.group,
            dirty: false,
          }
        })
        this.rowsByKey = new Map(this.allRows.map(r => [r.key, r]))
        this.filteredRows = this.allRows
        this.loaded = true
      } catch (error) {
        console.error('Failed to load settings:', error)
      }
    }
    return []
  }

  private applyFilter(): void {
    const q = this.searchValue.trim().toLowerCase()
    if (!q) {
      this.filteredRows = this.allRows
    } else {
      const tokens = q.split(/\s+/).filter(Boolean)
      this.filteredRows = this.allRows.filter(row => {
        const haystack = `${row.key} ${row.description} ${row.group}`.toLowerCase()
        return tokens.every(t => haystack.includes(t))
      })
    }
  }

  private buildTree(rows: SettingRow[]): SettingsGroup[] {
    const topMap = new Map<string, SettingRow[]>()
    for (const row of rows) {
      const top = row.key.split('.')[0]
      if (!topMap.has(top)) topMap.set(top, [])
      topMap.get(top)!.push(row)
    }

    const groups: SettingsGroup[] = []
    for (const [topPrefix, topRows] of topMap) {
      const topGroup: SettingsGroup = {
        prefix: topPrefix,
        displayName: topPrefix.charAt(0).toUpperCase() + topPrefix.slice(1),
        depth: 0,
        items: [],
        children: [],
      }

      const subMap = new Map<string, SettingRow[]>()
      for (const row of topRows) {
        const parts = row.key.split('.')
        if (parts.length > 2) {
          const subPrefix = parts[0] + '.' + parts[1]
          if (!subMap.has(subPrefix)) subMap.set(subPrefix, [])
          subMap.get(subPrefix)!.push(row)
        } else {
          topGroup.items.push(row)
        }
      }

      for (const [subPrefix, subRows] of subMap) {
        const subName = subPrefix.split('.')[1]
        topGroup.children.push({
          prefix: subPrefix,
          displayName: subName,
          depth: 1,
          items: subRows,
          children: [],
        })
      }

      groups.push(topGroup)
    }
    return groups
  }

  private countGroupItems(g: SettingsGroup): number {
    return g.items.length + g.children.reduce((sum, c) => sum + this.countGroupItems(c), 0)
  }

  private computeDirty(row: SettingRow): boolean {
    if (row.target !== row.originalTarget) return true
    if (row.target === 'default') return false
    return row.value !== row.originalValue
  }

  private get pendingCount(): number {
    return this.allRows.filter(r => r.dirty).length
  }

  renderContent(container: HTMLElement): void {
    this.container = container
    container.innerHTML = ''

    const searchInput = document.getElementById('searchInput') as HTMLInputElement | null
    if (searchInput) {
      this.searchValue = searchInput.value
      this.applyFilter()
    }

    if (this.filteredRows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = this.searchValue ? 'No matching settings' : 'No settings found'
      container.appendChild(empty)
      this.renderFooter(container)
      return
    }

    const scroll = document.createElement('div')
    scroll.className = 'settings-scroll'

    const isFiltering = this.searchValue.trim().length > 0
    const tree = this.buildTree(this.filteredRows)

    for (const group of tree) {
      this.renderGroup(scroll, group, isFiltering)
    }

    container.appendChild(scroll)

    if (this.error) {
      const errEl = document.createElement('div')
      errEl.className = 'edit-error'
      errEl.textContent = this.error
      container.appendChild(errEl)
    }

    this.renderFooter(container)
    this.bindFormEvents(container)

    if (this.focusedKey) {
      const inp = container.querySelector(`input[data-setting-key="${this.focusedKey}"]`) as HTMLInputElement | null
      if (inp && !inp.disabled) {
        inp.focus()
        if (this.focusCursorPos !== null) {
          inp.setSelectionRange(this.focusCursorPos, this.focusCursorPos)
        }
      }
    }
  }

  private renderGroup(parent: HTMLElement, group: SettingsGroup, isFiltering: boolean): void {
    const isCollapsed = !isFiltering && this.collapsed.has(group.prefix)
    const count = this.countGroupItems(group)
    const dirtyInGroup = this.countDirtyInGroup(group)

    const section = document.createElement('div')
    section.className = 'settings-section depth-' + group.depth

    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'settings-section-header'
    header.dataset.prefix = group.prefix

    const arrow = document.createElement('span')
    arrow.className = 'settings-section-arrow'
    arrow.textContent = isCollapsed ? '\u25B6' : '\u25BC'
    header.appendChild(arrow)

    const name = document.createElement('span')
    name.className = 'settings-section-name'
    name.textContent = group.displayName
    header.appendChild(name)

    const countBadge = document.createElement('span')
    countBadge.className = 'settings-section-count'
    countBadge.textContent = String(count)
    header.appendChild(countBadge)

    if (dirtyInGroup > 0) {
      const dirtyDot = document.createElement('span')
      dirtyDot.className = 'settings-section-dirty'
      header.appendChild(dirtyDot)
    }

    section.appendChild(header)

    if (!isCollapsed) {
      const body = document.createElement('div')
      body.className = 'settings-section-body'

      for (const row of group.items) {
        body.appendChild(this.renderCard(row))
      }

      for (const child of group.children) {
        this.renderGroup(body, child, isFiltering)
      }

      section.appendChild(body)
    }

    parent.appendChild(section)
  }

  private countDirtyInGroup(group: SettingsGroup): number {
    let count = group.items.filter(r => r.dirty).length
    for (const child of group.children) {
      count += this.countDirtyInGroup(child)
    }
    return count
  }

  private renderCard(row: SettingRow): HTMLElement {
    const card = document.createElement('div')
    card.className = 'settings-card'
      + (row.dirty ? ' dirty' : '')
      + (row.target === 'default' ? ' is-default' : '')
      + (this.focusedKey === row.key ? ' focused' : '')
    card.dataset.settingKey = row.key

    const nameEl = document.createElement('div')
    nameEl.className = 'settings-card-name'
    nameEl.textContent = row.shortName
    card.appendChild(nameEl)

    if (row.description) {
      const descEl = document.createElement('div')
      descEl.className = 'settings-card-desc'
      descEl.textContent = row.description
      card.appendChild(descEl)
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'settings-card-input'
    input.value = row.value
    input.placeholder = '(default)'
    input.dataset.settingKey = row.key
    if (row.target === 'default') input.disabled = true
    card.appendChild(input)

    const toggle = document.createElement('div')
    toggle.className = 'settings-target'
    for (const t of ['default', 'global', 'agent'] as SettingTarget[]) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'settings-target-btn' + (row.target === t ? ' active' : '')
      btn.textContent = t.charAt(0).toUpperCase() + t.slice(1)
      btn.dataset.settingKey = row.key
      btn.dataset.target = t
      toggle.appendChild(btn)
    }
    card.appendChild(toggle)

    return card
  }

  private renderFooter(container: HTMLElement): void {
    const count = this.pendingCount
    const footer = document.createElement('div')
    footer.className = 'settings-footer'

    if (count > 0) {
      const badge = document.createElement('span')
      badge.className = 'settings-dirty-badge'
      badge.textContent = `${count} unsaved change${count > 1 ? 's' : ''}`
      footer.appendChild(badge)
    }

    const spacer = document.createElement('div')
    spacer.style.flex = '1'
    footer.appendChild(spacer)

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'btn'
    cancelBtn.type = 'button'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.dataset.action = 'cancel'
    footer.appendChild(cancelBtn)

    const saveBtn = document.createElement('button')
    saveBtn.className = 'btn primary'
    saveBtn.type = 'button'
    saveBtn.textContent = this.saving ? 'Saving\u2026' : 'Save'
    saveBtn.dataset.action = 'save'
    if (count === 0 || this.saving) {
      saveBtn.setAttribute('disabled', '')
      saveBtn.style.opacity = '0.5'
      saveBtn.style.cursor = 'default'
    }
    footer.appendChild(saveBtn)
    container.appendChild(footer)
  }

  private bindFormEvents(container: HTMLElement): void {
    container.querySelectorAll('.settings-section-header').forEach(el => {
      (el as HTMLButtonElement).addEventListener('click', () => {
        const prefix = (el as HTMLElement).dataset.prefix!
        if (this.collapsed.has(prefix)) {
          this.collapsed.delete(prefix)
        } else {
          this.collapsed.add(prefix)
        }
        this.renderContent(container)
      })
    })

    container.querySelectorAll('.settings-card-input').forEach(el => {
      const inp = el as HTMLInputElement
      const key = inp.dataset.settingKey!

      inp.addEventListener('input', () => {
        const row = this.rowsByKey.get(key)
        if (!row) return
        row.value = inp.value
        row.dirty = this.computeDirty(row)
        inp.closest('.settings-card')?.classList.toggle('dirty', row.dirty)
        this.rerenderFooter(container)
      })

      inp.addEventListener('focus', () => {
        this.focusedKey = key
        inp.closest('.settings-card')?.classList.add('focused')
      })

      inp.addEventListener('blur', () => {
        if (this.focusedKey === key) {
          this.focusCursorPos = inp.selectionStart
          this.focusedKey = null
        }
        inp.closest('.settings-card')?.classList.remove('focused')
      })

      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); void this.saveAll() }
      })
    })

    container.querySelectorAll('.settings-target-btn').forEach(el => {
      (el as HTMLButtonElement).addEventListener('click', () => {
        const key = (el as HTMLElement).dataset.settingKey!
        const newTarget = (el as HTMLElement).dataset.target as SettingTarget
        const row = this.rowsByKey.get(key)
        if (!row) return

        row.target = newTarget
        row.dirty = this.computeDirty(row)

        const card = container.querySelector(`.settings-card[data-setting-key="${key}"]`)
        if (card) {
          card.querySelectorAll('.settings-target-btn').forEach(b => {
            b.classList.toggle('active', (b as HTMLElement).dataset.target === newTarget)
          })
          const inp = card.querySelector('.settings-card-input') as HTMLInputElement
          if (inp) {
            inp.disabled = newTarget === 'default'
            if (newTarget === 'default') {
              inp.value = ''
              row.value = ''
            } else if (!inp.value && row.originalValue) {
              inp.value = row.originalValue
              row.value = row.originalValue
            }
          }
          card.classList.toggle('dirty', row.dirty)
          card.classList.toggle('is-default', newTarget === 'default')
        }

        this.rerenderFooter(container)
      })
    })

  }

  private rerenderFooter(container: HTMLElement): void {
    const old = container.querySelector('.settings-footer')
    if (old) old.remove()
    const oldErr = container.querySelector('.edit-error')
    if (oldErr) oldErr.remove()
    if (this.error) {
      const errEl = document.createElement('div')
      errEl.className = 'edit-error'
      errEl.textContent = this.error
      container.appendChild(errEl)
    }
    this.renderFooter(container)
    const saveBtn = container.querySelector('[data-action="save"]')
    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => { e.preventDefault(); void this.saveAll() })
    }
  }

  async saveAll(): Promise<void> {
    const dirtyRows = this.allRows.filter(r => r.dirty)
    if (dirtyRows.length === 0 || this.saving) return

    this.saving = true
    this.error = ''

    try {
      for (const row of dirtyRows) {
        if (row.target === 'default') {
          await this.bridge.clearToDefault(row.key)
          row.value = ''
          row.originalValue = ''
          row.originalTarget = 'default'
        } else {
          const result = await this.bridge.updateSetting(row.key, row.value, row.target)
          if (!result.success) {
            this.error = `Failed to save ${row.label}: ${result.error || 'Unknown error'}`
            return
          }
          row.originalValue = row.value
          row.originalTarget = row.target
        }
        row.dirty = false
      }
    } catch {
      this.error = 'Failed to save settings'
    } finally {
      this.saving = false
      if (this.container) this.renderContent(this.container)
    }
  }

  async onEnter(): Promise<ScreenResult> {
    return { type: 'none' }
  }

  onExternalUpdate(detail: { key: string; value: unknown }): void {
    const row = this.rowsByKey.get(detail.key)
    if (row && !row.dirty) {
      row.value = detail.value !== undefined ? String(detail.value) : ''
      row.originalValue = row.value
    }
  }
}
