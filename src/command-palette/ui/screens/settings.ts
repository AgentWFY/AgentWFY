import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

type SettingTarget = 'default' | 'global' | 'agent'

interface SettingRow {
  key: string
  /** Key minus its top-level prefix; e.g. `system.backup.interval-hours` → `backup.interval-hours`. */
  shortName: string
  /** Display name for depth-0 rendering — same as `shortName`. */
  displayName0: string
  /** Display name for depth-1 rendering — strips one extra segment (`backup.interval-hours` → `interval-hours`). */
  displayName1: string
  description: string
  value: string
  originalValue: string
  originalTarget: SettingTarget
  target: SettingTarget
  group: string
  dirty: boolean
}

interface GroupNode {
  prefix: string
  displayName: string
  depth: number
  items: SettingRow[]
  children: GroupNode[]
}

const SETTINGS_WIDTH = 640
const SETTINGS_HEIGHT = 520

const SCOPE_INFO: Record<SettingTarget, { label: string; title: string; name: string }> = {
  default: { label: '·', title: 'Default value', name: 'Default' },
  global: { label: 'G', title: 'Global override', name: 'Global' },
  agent: { label: 'A', title: 'Agent override', name: 'Agent' },
}

const SCOPE_OPTIONS: SettingTarget[] = ['default', 'global', 'agent']

/** Top-level group prefix and (optional) sub-group prefix for a setting key. */
function prefixesFor(key: string): { top: string; sub: string | null } {
  const parts = key.split('.')
  if (parts.length <= 1) return { top: key, sub: null }
  if (parts.length === 2) return { top: parts[0], sub: null }
  return { top: parts[0], sub: `${parts[0]}.${parts[1]}` }
}

function buildTree(rows: SettingRow[]): GroupNode[] {
  const topMap = new Map<string, SettingRow[]>()
  for (const row of rows) {
    const { top } = prefixesFor(row.key)
    if (!topMap.has(top)) topMap.set(top, [])
    topMap.get(top)!.push(row)
  }

  const groups: GroupNode[] = []
  for (const [topPrefix, topRows] of topMap) {
    const subMap = new Map<string, SettingRow[]>()
    const directItems: SettingRow[] = []

    for (const row of topRows) {
      const { sub } = prefixesFor(row.key)
      if (sub) {
        if (!subMap.has(sub)) subMap.set(sub, [])
        subMap.get(sub)!.push(row)
      } else {
        directItems.push(row)
      }
    }

    const children: GroupNode[] = []
    for (const [subPrefix, subRows] of subMap) {
      children.push({
        prefix: subPrefix,
        displayName: subPrefix.split('.')[1],
        depth: 1,
        items: subRows,
        children: [],
      })
    }

    groups.push({
      prefix: topPrefix,
      displayName: topPrefix,
      depth: 0,
      items: directItems,
      children,
    })
  }
  return groups
}

function collectAllPrefixes(groups: GroupNode[], out: string[] = []): string[] {
  for (const g of groups) {
    out.push(g.prefix)
    collectAllPrefixes(g.children, out)
  }
  return out
}

function countItems(g: GroupNode): number {
  return g.items.length + g.children.reduce((s, c) => s + countItems(c), 0)
}

function countDirty(g: GroupNode): number {
  return g.items.filter(r => r.dirty).length
    + g.children.reduce((s, c) => s + countDirty(c), 0)
}

export class SettingsScreen implements PaletteScreen {
  readonly id = 'settings'
  readonly breadcrumb = 'Settings'
  readonly placeholder = 'Filter settings…'
  readonly emptyText = 'No settings found'
  readonly hints: Array<{ key: string; label: string }> = []
  readonly searchIsFilter = false
  readonly navigable = false

  private readonly bridge: CommandPaletteBridge
  private allRows: SettingRow[] = []
  private rowsByKey = new Map<string, SettingRow>()
  private filteredRows: SettingRow[] = []
  private visibleRows: SettingRow[] = []
  private collapsed = new Set<string>()
  private selectedIndex = 0
  private expandedKey: string | null = null
  private error = ''
  private saving = false
  private searchValue = ''
  private loaded = false
  private container: HTMLElement | null = null
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  /** Container DOM node we've already wired delegated listeners onto (avoids per-render leak). */
  private wiredContainer: HTMLElement | null = null
  private clickHandler: ((e: Event) => void) | null = null
  private mouseoverHandler: ((e: Event) => void) | null = null
  private inputHandler: ((e: Event) => void) | null = null
  /** Last rendered dirty-row count; lets `refreshFooter` skip DOM swaps when nothing meaningful changed. */
  private lastFooterCount = -1
  initialSearchValue?: string

  constructor(bridge: CommandPaletteBridge, params?: { filter?: string }) {
    this.bridge = bridge
    if (params?.filter) {
      this.searchValue = String(params.filter)
      this.initialSearchValue = this.searchValue
    }
  }

  onActivate(): void {
    void this.bridge.resize({ width: SETTINGS_WIDTH, height: SETTINGS_HEIGHT })
    this.attachKeyHandler()
  }

  onDeactivate(): void {
    void this.bridge.resize({ width: 0, height: 0 })
    this.detachKeyHandler()
    this.detachContainerEvents()
  }

  private detachContainerEvents(): void {
    if (!this.wiredContainer) return
    if (this.clickHandler) this.wiredContainer.removeEventListener('click', this.clickHandler)
    if (this.mouseoverHandler) this.wiredContainer.removeEventListener('mouseover', this.mouseoverHandler)
    if (this.inputHandler) this.wiredContainer.removeEventListener('input', this.inputHandler)
    this.clickHandler = null
    this.mouseoverHandler = null
    this.inputHandler = null
    this.wiredContainer = null
  }

  private attachKeyHandler(): void {
    if (this.keyHandler) return
    this.keyHandler = (e: KeyboardEvent) => this.handleKey(e)
    document.addEventListener('keydown', this.keyHandler, true)
  }

  private detachKeyHandler(): void {
    if (!this.keyHandler) return
    document.removeEventListener('keydown', this.keyHandler, true)
    this.keyHandler = null
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return

    const target = e.target as HTMLElement | null
    const inEditInput = target instanceof HTMLInputElement && target.classList.contains('set-row-input')

    if (inEditInput) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.collapse()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        this.advanceFromExpanded()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        this.cycleScope(e.shiftKey ? -1 : 1)
      }
      return
    }

    const isDown = e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'j' || e.key === 'n'))
    const isUp = e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'k' || e.key === 'p'))

    if (isDown) {
      e.preventDefault()
      this.moveSelection(1)
    } else if (isUp) {
      e.preventDefault()
      this.moveSelection(-1)
    }
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
          const shortName = parts.length > 1 ? parts.slice(1).join('.') : key
          const displayName1 = parts.length > 2 ? parts.slice(2).join('.') : shortName
          return {
            key,
            shortName,
            displayName0: shortName,
            displayName1,
            description: item.subtitle || '',
            value: item.settingValue ?? '',
            originalValue: item.settingValue ?? '',
            originalTarget: source,
            target: source,
            group: item.group,
            dirty: false,
          }
        })
        this.allRows.sort((a, b) => a.key.localeCompare(b.key))
        this.rowsByKey = new Map(this.allRows.map(r => [r.key, r]))
        this.filteredRows = this.allRows
        this.loaded = true
        if (this.searchValue) this.applyFilter()
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
    if (this.expandedKey && !this.filteredRows.some(r => r.key === this.expandedKey)) {
      this.expandedKey = null
    }
  }

  private get isFiltering(): boolean {
    return this.searchValue.trim().length > 0
  }

  private collectVisible(groups: GroupNode[], filtering: boolean, out: SettingRow[] = []): SettingRow[] {
    for (const g of groups) {
      const isCollapsed = !filtering && this.collapsed.has(g.prefix)
      if (isCollapsed) continue
      out.push(...g.items)
      this.collectVisible(g.children, filtering, out)
    }
    return out
  }

  /** Build the tree from `filteredRows` and derive `visibleRows` from it. Returns the tree. */
  private rebuildTreeAndVisible(): GroupNode[] {
    const tree = buildTree(this.filteredRows)
    this.visibleRows = this.collectVisible(tree, this.isFiltering)
    if (this.selectedIndex >= this.visibleRows.length) {
      this.selectedIndex = Math.max(0, this.visibleRows.length - 1)
    }
    return tree
  }

  private rerender(): void {
    if (this.container) this.renderContent(this.container)
  }

  private toggleGroup(prefix: string): void {
    if (this.collapsed.has(prefix)) {
      this.collapsed.delete(prefix)
    } else {
      this.collapsed.add(prefix)
    }
    this.rerender()
  }

  private collapseAll(): void {
    for (const p of collectAllPrefixes(buildTree(this.allRows))) this.collapsed.add(p)
    this.expandedKey = null
    this.rerender()
  }

  private expandAll(): void {
    this.collapsed.clear()
    this.rerender()
  }

  private computeDirty(row: SettingRow): boolean {
    if (row.target !== row.originalTarget) return true
    if (row.target === 'default') return false
    return row.value !== row.originalValue
  }

  private get pendingCount(): number {
    return this.allRows.filter(r => r.dirty).length
  }

  private moveSelection(delta: number): void {
    if (this.visibleRows.length === 0) return
    this.selectedIndex = (this.selectedIndex + delta + this.visibleRows.length) % this.visibleRows.length
    const needsCollapse = this.expandedKey && this.visibleRows[this.selectedIndex]?.key !== this.expandedKey
    if (needsCollapse) {
      this.expandedKey = null
      this.rerender()
    } else {
      this.updateActiveClass()
    }
    this.scrollSelectedIntoView()
  }

  private expand(key: string): void {
    // Make sure ancestor groups aren't collapsed, otherwise the row wouldn't be visible.
    const { top, sub } = prefixesFor(key)
    this.collapsed.delete(top)
    if (sub) this.collapsed.delete(sub)
    this.rebuildTreeAndVisible()
    this.expandedKey = key
    const idx = this.visibleRows.findIndex(r => r.key === key)
    if (idx >= 0) this.selectedIndex = idx
    this.rerender()
    this.focusExpandedInput({ selectToEnd: true })
    this.scrollSelectedIntoView()
  }

  private collapse(): void {
    this.expandedKey = null
    this.rerender()
    this.focusSearch()
  }

  private cycleScope(direction: number): void {
    if (!this.expandedKey) return
    const row = this.rowsByKey.get(this.expandedKey)
    if (!row) return
    const idx = SCOPE_OPTIONS.indexOf(row.target)
    const next = SCOPE_OPTIONS[(idx + direction + SCOPE_OPTIONS.length) % SCOPE_OPTIONS.length]
    this.applyScopeChange(row, next)
    this.rerender()
    this.focusExpandedInput()
  }

  private applyScopeChange(row: SettingRow, next: SettingTarget): void {
    row.target = next
    if (next === 'default') {
      row.value = ''
    } else if (!row.value && row.originalValue) {
      row.value = row.originalValue
    }
    row.dirty = this.computeDirty(row)
  }

  private advanceFromExpanded(): void {
    if (!this.expandedKey) return
    const currentIdx = this.visibleRows.findIndex(r => r.key === this.expandedKey)
    this.expandedKey = null
    if (currentIdx >= 0 && currentIdx < this.visibleRows.length - 1) {
      this.selectedIndex = currentIdx + 1
    }
    this.rerender()
    this.focusSearch()
  }

  private focusExpandedInput(options?: { selectToEnd?: boolean }): void {
    if (!this.expandedKey || !this.container) return
    const inp = this.container.querySelector(
      `.set-row[data-key="${CSS.escape(this.expandedKey)}"] .set-row-input`,
    ) as HTMLInputElement | null
    if (!inp || inp.disabled) return
    inp.focus()
    if (options?.selectToEnd) {
      const len = inp.value.length
      inp.setSelectionRange(len, len)
    }
  }

  private focusSearch(): void {
    const search = document.getElementById('searchInput') as HTMLInputElement | null
    search?.focus()
  }

  private scrollSelectedIntoView(): void {
    const el = this.container?.querySelector('.set-row.active') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }

  private updateActiveClass(): void {
    if (!this.container) return
    this.container.querySelectorAll('.set-row').forEach(el => {
      const idx = Number((el as HTMLElement).dataset.index)
      if (Number.isFinite(idx)) {
        el.classList.toggle('active', idx === this.selectedIndex)
      }
    })
  }

  private clearActiveClass(): void {
    if (!this.container) return
    this.container.querySelectorAll('.set-row.active').forEach(el => {
      el.classList.remove('active')
    })
  }

  renderContent(container: HTMLElement): void {
    this.container = container

    // Save scrollTop so navigation, expand/collapse, and hover don't snap back to top.
    const oldList = container.querySelector('.set-list')
    const savedScroll = oldList instanceof HTMLElement ? oldList.scrollTop : 0

    const searchInput = document.getElementById('searchInput') as HTMLInputElement | null
    let searchChanged = false
    if (searchInput) {
      const newSearch = searchInput.value
      if (newSearch !== this.searchValue) {
        this.searchValue = newSearch
        this.applyFilter()
        searchChanged = true
      }
    }

    const tree = this.rebuildTreeAndVisible()

    container.innerHTML = ''

    if (this.filteredRows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = this.searchValue ? 'No matching settings' : 'No settings found'
      container.appendChild(empty)
      this.renderFooter(container)
      this.bindContainerEvents(container)
      return
    }

    container.appendChild(this.renderToolbar())

    const list = document.createElement('div')
    list.className = 'set-list'

    const filtering = this.isFiltering
    let cursor = 0
    for (const group of tree) {
      cursor = this.renderGroup(list, group, filtering, cursor)
    }

    container.appendChild(list)
    list.scrollTop = searchChanged ? 0 : savedScroll

    if (this.error) {
      const errEl = document.createElement('div')
      errEl.className = 'edit-error'
      errEl.textContent = this.error
      container.appendChild(errEl)
    }

    this.renderFooter(container)
    this.bindContainerEvents(container)
  }

  private renderToolbar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'set-toolbar'
    const collapseBtn = document.createElement('button')
    collapseBtn.type = 'button'
    collapseBtn.className = 'set-toolbar-btn'
    collapseBtn.textContent = 'collapse all'
    collapseBtn.dataset.action = 'collapse-all'
    bar.appendChild(collapseBtn)
    const expandBtn = document.createElement('button')
    expandBtn.type = 'button'
    expandBtn.className = 'set-toolbar-btn'
    expandBtn.textContent = 'expand all'
    expandBtn.dataset.action = 'expand-all'
    bar.appendChild(expandBtn)
    return bar
  }

  /** Returns the next row index to use after rendering this group's contents. */
  private renderGroup(parent: HTMLElement, group: GroupNode, filtering: boolean, startIndex: number): number {
    const isCollapsed = !filtering && this.collapsed.has(group.prefix)
    const total = countItems(group)
    const dirty = countDirty(group)

    const section = document.createElement('div')
    section.className = `set-section depth-${group.depth}`

    const header = document.createElement('button')
    header.type = 'button'
    header.className = this.classes('set-group-header', `depth-${group.depth}`, isCollapsed && 'collapsed', dirty > 0 && 'has-dirty')
    header.dataset.prefix = group.prefix

    const arrow = document.createElement('span')
    arrow.className = 'set-group-arrow'
    arrow.textContent = isCollapsed ? '▶' : '▾'
    header.appendChild(arrow)

    const name = document.createElement('span')
    name.className = 'set-group-name'
    name.textContent = group.displayName
    header.appendChild(name)

    const count = document.createElement('span')
    count.className = 'set-group-count'
    count.textContent = String(total)
    header.appendChild(count)

    if (dirty > 0) {
      const dot = document.createElement('span')
      dot.className = 'set-group-dirty'
      header.appendChild(dot)
    }

    section.appendChild(header)

    let cursor = startIndex
    if (!isCollapsed) {
      for (const row of group.items) {
        section.appendChild(this.renderRow(row, cursor, group.depth))
        cursor++
      }
      for (const child of group.children) {
        cursor = this.renderGroup(section, child, filtering, cursor)
      }
    }

    parent.appendChild(section)
    return cursor
  }

  private classes(...parts: Array<string | false | undefined>): string {
    return parts.filter(Boolean).join(' ')
  }

  private renderRow(row: SettingRow, index: number, depth = 0): HTMLElement {
    const expanded = this.expandedKey === row.key
    const active = index === this.selectedIndex

    const el = document.createElement('div')
    el.className = this.classes('set-row', `depth-${depth}`, active && 'active', expanded && 'expanded', row.dirty && 'dirty')
    el.dataset.key = row.key
    el.dataset.index = String(index)

    const head = document.createElement('div')
    head.className = 'set-row-head'

    const name = document.createElement('div')
    name.className = 'set-row-name'
    name.textContent = depth === 1 ? row.displayName1 : row.displayName0
    head.appendChild(name)

    if (!expanded) {
      const value = document.createElement('div')
      value.className = 'set-row-value'
      value.textContent = row.value || (row.target === 'default' ? '' : '(empty)')
      if (!row.value) value.classList.add('is-empty')
      head.appendChild(value)
    }

    const scope = SCOPE_INFO[row.target]
    const source = document.createElement('div')
    source.className = 'set-row-source source-' + row.target
    source.textContent = scope.label
    source.title = scope.title
    head.appendChild(source)

    el.appendChild(head)

    if (expanded) el.appendChild(this.renderEdit(row))

    return el
  }

  private renderEdit(row: SettingRow): HTMLElement {
    const edit = document.createElement('div')
    edit.className = 'set-row-edit'

    if (row.description) {
      const desc = document.createElement('div')
      desc.className = 'set-row-desc'
      desc.textContent = row.description
      edit.appendChild(desc)
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'set-row-input'
    input.value = row.value
    input.placeholder = row.target === 'default' ? '(default)' : 'value'
    input.spellcheck = false
    input.dataset.key = row.key
    if (row.target === 'default') input.disabled = true
    edit.appendChild(input)

    const controls = document.createElement('div')
    controls.className = 'set-row-controls'

    const scopeWrap = document.createElement('div')
    scopeWrap.className = 'set-row-scopes'
    const scopeLabel = document.createElement('span')
    scopeLabel.className = 'set-row-scope-label'
    scopeLabel.textContent = 'Save to'
    scopeWrap.appendChild(scopeLabel)
    for (const t of SCOPE_OPTIONS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = this.classes('set-row-scope', row.target === t && 'active')
      btn.textContent = SCOPE_INFO[t].name
      btn.dataset.key = row.key
      btn.dataset.target = t
      scopeWrap.appendChild(btn)
    }
    controls.appendChild(scopeWrap)

    const hint = document.createElement('span')
    hint.className = 'set-row-hint'
    hint.textContent = 'Enter to confirm · Tab cycles scope · Esc closes'
    controls.appendChild(hint)

    edit.appendChild(controls)
    return edit
  }

  private renderFooter(container: HTMLElement): void {
    const count = this.pendingCount
    if (count === 0 && !this.saving) {
      this.lastFooterCount = 0
      return
    }

    const footer = document.createElement('div')
    footer.className = 'set-footer'

    const badge = document.createElement('span')
    badge.className = 'set-footer-badge'
    badge.textContent = `${count} unsaved change${count === 1 ? '' : 's'}`
    footer.appendChild(badge)

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'btn'
    cancelBtn.type = 'button'
    cancelBtn.textContent = 'Discard'
    cancelBtn.dataset.action = 'discard'
    footer.appendChild(cancelBtn)

    const saveBtn = document.createElement('button')
    saveBtn.className = 'btn primary'
    saveBtn.type = 'button'
    saveBtn.textContent = this.saving ? 'Saving…' : `Save ${count}`
    saveBtn.dataset.action = 'save-all'
    if (this.saving) saveBtn.setAttribute('disabled', '')
    footer.appendChild(saveBtn)

    container.appendChild(footer)
    this.lastFooterCount = count
  }

  /** All container-level events are delegated and attach exactly once per container DOM
   *  node — `renderContent` wipes children via `innerHTML = ''` but keeps the container
   *  itself, so per-render `addEventListener` would otherwise leak handlers indefinitely. */
  private bindContainerEvents(container: HTMLElement): void {
    if (this.wiredContainer === container) return
    // Container persists across screens, so detach prior bindings before re-attaching.
    this.detachContainerEvents()
    this.wiredContainer = container

    this.mouseoverHandler = (event: Event) => {
      if (this.expandedKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      const row = target.closest('.set-row')
      if (row instanceof HTMLElement) {
        const idx = Number(row.dataset.index)
        if (!Number.isFinite(idx)) return
        if (this.selectedIndex === idx && row.classList.contains('active')) return
        this.selectedIndex = idx
        this.updateActiveClass()
      } else {
        this.clearActiveClass()
      }
    }
    container.addEventListener('mouseover', this.mouseoverHandler)

    this.clickHandler = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return

      const actionEl = target.closest('[data-action]') as HTMLElement | null
      if (actionEl) {
        const action = actionEl.dataset.action
        if (action === 'collapse-all') { event.preventDefault(); this.collapseAll(); return }
        if (action === 'expand-all')   { event.preventDefault(); this.expandAll(); return }
        if (action === 'save-all')     { event.preventDefault(); void this.saveAll(); return }
        if (action === 'discard')      { event.preventDefault(); this.discardAll(); return }
      }

      const scope = target.closest('.set-row-scope') as HTMLElement | null
      if (scope) {
        event.stopPropagation()
        const key = scope.dataset.key
        const next = scope.dataset.target as SettingTarget | undefined
        if (!key || !next) return
        const row = this.rowsByKey.get(key)
        if (!row) return
        this.applyScopeChange(row, next)
        this.rerender()
        this.focusExpandedInput()
        return
      }

      const header = target.closest('.set-group-header') as HTMLElement | null
      if (header) {
        const prefix = header.dataset.prefix
        if (prefix) this.toggleGroup(prefix)
        return
      }

      const head = target.closest('.set-row-head') as HTMLElement | null
      if (head) {
        const key = (head.closest('.set-row') as HTMLElement | null)?.dataset.key
        if (!key) return
        if (this.expandedKey === key) this.collapse()
        else this.expand(key)
      }
    }
    container.addEventListener('click', this.clickHandler)

    this.inputHandler = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement)) return
      if (!target.classList.contains('set-row-input')) return
      const key = target.dataset.key
      if (!key) return
      const row = this.rowsByKey.get(key)
      if (!row) return
      row.value = target.value
      row.dirty = this.computeDirty(row)
      target.closest('.set-row')?.classList.toggle('dirty', row.dirty)
      this.refreshFooter(container)
    }
    container.addEventListener('input', this.inputHandler)
  }

  /** Update only the footer when dirty count changes. No-op if count is unchanged. */
  private refreshFooter(container: HTMLElement): void {
    const count = this.pendingCount
    if (count === this.lastFooterCount && !this.saving && !this.error) return
    container.querySelector('.set-footer')?.remove()
    container.querySelector('.edit-error')?.remove()
    if (this.error) {
      const errEl = document.createElement('div')
      errEl.className = 'edit-error'
      errEl.textContent = this.error
      container.appendChild(errEl)
    }
    this.renderFooter(container)
  }

  private discardAll(): void {
    for (const row of this.allRows) {
      if (!row.dirty) continue
      row.value = row.originalValue
      row.target = row.originalTarget
      row.dirty = false
    }
    this.error = ''
    this.rerender()
  }

  async saveAll(): Promise<void> {
    const dirtyRows = this.allRows.filter(r => r.dirty)
    if (dirtyRows.length === 0 || this.saving) return

    this.saving = true
    this.error = ''
    if (this.container) this.refreshFooter(this.container)

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
            this.error = `Failed to save ${row.key}: ${result.error || 'Unknown error'}`
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
      this.rerender()
    }
  }

  async onEnter(): Promise<ScreenResult> {
    const row = this.visibleRows[this.selectedIndex]
    if (row) {
      if (this.expandedKey === row.key) {
        this.collapse()
      } else {
        this.expand(row.key)
      }
    }
    return { type: 'none' }
  }

  // Don't clobber in-progress user edits; refresh display only when the row is clean.
  onExternalUpdate(detail: { key: string; value: unknown }): void {
    const row = this.rowsByKey.get(detail.key)
    if (!row || row.dirty) return
    row.value = detail.value !== undefined ? String(detail.value) : ''
    row.originalValue = row.value
    this.rerender()
  }
}
