import type { PaletteScreen, ScreenResult } from './screen.js'
import type { CommandPaletteBridge } from './bridge.js'
import type { CommandPaletteAction, CommandPaletteItem } from '../types.js'

export class PaletteController {
  private readonly stack: PaletteScreen[] = []
  private readonly bridge: CommandPaletteBridge
  private readonly searchInput: HTMLInputElement
  private readonly resultsEl: HTMLElement
  private readonly breadcrumbEl: HTMLElement
  private readonly hintBar: HTMLElement

  private items: CommandPaletteItem[] = []
  private filtered: CommandPaletteItem[] = []
  private selectedIndex = 0
  private actionInFlight = false

  constructor(
    bridge: CommandPaletteBridge,
    elements: {
      searchInput: HTMLInputElement
      resultsEl: HTMLElement
      breadcrumbEl: HTMLElement
      hintBar: HTMLElement
    },
  ) {
    this.bridge = bridge
    this.searchInput = elements.searchInput
    this.resultsEl = elements.resultsEl
    this.breadcrumbEl = elements.breadcrumbEl
    this.hintBar = elements.hintBar

    this.bindEvents()
  }

  get currentScreen(): PaletteScreen | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null
  }

  push(screen: PaletteScreen): void {
    this.currentScreen?.onDeactivate?.()
    this.stack.push(screen)
    void this.activateScreen()
  }

  pop(): void {
    if (this.stack.length <= 1) {
      void this.bridge.close()
      return
    }

    const popped = this.stack.pop()!
    popped.onDeactivate?.()
    void this.activateScreen()
  }

  reset(screen: PaletteScreen): void {
    for (const s of this.stack) {
      s.onDeactivate?.()
    }
    this.stack.length = 0
    this.stack.push(screen)
    void this.activateScreen()
  }

  resetAndPush(base: PaletteScreen, target: PaletteScreen): void {
    for (const s of this.stack) {
      s.onDeactivate?.()
    }
    this.stack.length = 0
    this.stack.push(base)
    this.stack.push(target)
    void this.activateScreen()
  }

  handleSettingChanged(detail: { key: string; value: unknown }): void {
    for (const screen of this.stack) {
      screen.onExternalUpdate?.(detail)
    }

    const current = this.currentScreen
    if (current && (current.id === 'settings' || current.id === 'agent-settings' || current.id === 'editing')) {
      void this.loadAndRenderItems()
    }
  }

  private async activateScreen(): Promise<void> {
    const screen = this.currentScreen
    if (!screen) return

    screen.onActivate?.()

    // Update breadcrumb
    if (screen.breadcrumb) {
      this.breadcrumbEl.style.display = 'block'
      this.breadcrumbEl.textContent = screen.breadcrumb
    } else {
      this.breadcrumbEl.style.display = 'none'
      this.breadcrumbEl.textContent = ''
    }

    // Update hints
    this.hintBar.innerHTML = screen.hints
      .map(h => `<span class="hint-item"><span class="hint-key">${h.key}</span> ${h.label}</span>`)
      .join('')

    // Update search
    this.searchInput.placeholder = screen.placeholder
    if (screen.initialSearchValue !== undefined) {
      this.searchInput.value = screen.initialSearchValue
    } else {
      this.searchInput.value = ''
    }

    this.selectedIndex = screen.initialSelectedIndex ?? 0

    await this.loadAndRenderItems()

    this.searchInput.focus()
    if (screen.initialSearchValue !== undefined) {
      this.searchInput.select()
    }
  }

  private async loadAndRenderItems(): Promise<void> {
    const screen = this.currentScreen
    if (!screen) return

    this.items = await screen.getItems()
    if (screen.searchIsFilter) {
      this.applyFilter()
    } else {
      this.filtered = this.items
      this.render()
    }
  }

  private applyFilter(): void {
    const query = this.searchInput.value.trim()
    this.filtered = this.items.filter((item) => this.scoreMatches(item, query))
    this.clampSelectedIndex()
    this.render()
  }

  private scoreMatches(item: CommandPaletteItem, query: string): boolean {
    if (!query) return true
    const haystack = `${item.title || ''} ${item.subtitle || ''} ${item.group || ''}`.toLowerCase()
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    return tokens.every((token) => haystack.includes(token))
  }

  private clampSelectedIndex(): void {
    if (this.filtered.length === 0) {
      this.selectedIndex = 0
      return
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filtered.length - 1))
  }

  private render(): void {
    const screen = this.currentScreen
    if (!screen) return

    this.resultsEl.innerHTML = ''

    // If screen provides custom content and has no items, render custom content
    if (screen.renderContent && this.filtered.length === 0) {
      screen.renderContent(this.resultsEl)
      return
    }

    // Render filterable item list
    if (this.filtered.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'empty'
      emptyEl.textContent = screen.emptyText
      this.resultsEl.appendChild(emptyEl)
      return
    }

    // Hide group titles when the breadcrumb already provides context
    // (i.e., sub-screens with a single group don't need a redundant header)
    const uniqueGroups = new Set(this.filtered.map(i => i.group))
    const hideGroupTitles = screen.breadcrumb !== null && uniqueGroups.size <= 1

    let lastGroup = ''
    this.filtered.forEach((item, index) => {
      if (!hideGroupTitles && item.group !== lastGroup) {
        lastGroup = item.group
        const groupTitleEl = document.createElement('div')
        groupTitleEl.className = 'group-title'
        groupTitleEl.textContent = item.group
        this.resultsEl.appendChild(groupTitleEl)
      }

      const itemButton = document.createElement('button')
      itemButton.type = 'button'
      itemButton.className = 'item' + (index === this.selectedIndex ? ' active' : '')
      itemButton.dataset.index = String(index)

      const contentEl = document.createElement('div')
      contentEl.className = 'item-content'

      const titleEl = document.createElement('div')
      titleEl.className = 'item-title'
      titleEl.textContent = item.title || ''
      contentEl.appendChild(titleEl)

      if (item.subtitle) {
        const subtitleEl = document.createElement('div')
        subtitleEl.className = 'item-subtitle'
        subtitleEl.textContent = item.subtitle
        contentEl.appendChild(subtitleEl)
      }

      itemButton.appendChild(contentEl)

      if (item.shortcut) {
        const shortcutEl = document.createElement('span')
        shortcutEl.className = 'item-shortcut'
        shortcutEl.textContent = item.shortcut
        itemButton.appendChild(shortcutEl)
      }

      if (item.settingValue !== undefined) {
        const valueEl = document.createElement('span')
        valueEl.className = 'setting-value'
        valueEl.textContent = item.settingValue || '(empty)'
        itemButton.appendChild(valueEl)
      }

      this.resultsEl.appendChild(itemButton)
    })

    // Append custom content below item list if screen provides it
    if (screen.renderContent) {
      screen.renderContent(this.resultsEl)
    }
  }

  private updateActiveItem(): void {
    const items = this.resultsEl.querySelectorAll('.item')
    items.forEach((el) => {
      const idx = Number((el as HTMLElement).dataset.index)
      if (idx === this.selectedIndex) {
        el.classList.add('active')
      } else {
        el.classList.remove('active')
      }
    })
  }

  private scrollActiveIntoView(): void {
    const activeEl = this.resultsEl.querySelector('.item.active')
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }

  private selectNext(): void {
    if (this.filtered.length === 0) return
    this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length
    this.updateActiveItem()
    this.scrollActiveIntoView()
  }

  private selectPrev(): void {
    if (this.filtered.length === 0) return
    this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length
    this.updateActiveItem()
    this.scrollActiveIntoView()
  }

  private async handleResult(result: ScreenResult): Promise<void> {
    switch (result.type) {
      case 'push':
        this.push(result.screen)
        break
      case 'pop':
        this.pop()
        break
      case 'close':
        await this.bridge.close()
        break
      case 'action':
        this.actionInFlight = true
        try {
          await this.bridge.runAction(result.action as CommandPaletteAction)
        } catch (error) {
          console.error('Failed to run command palette action:', error)
        } finally {
          this.actionInFlight = false
        }
        break
      case 'none':
        // Re-render in case the screen updated internal state (e.g., error message)
        this.render()
        break
    }
  }

  private async handleEnterKey(): Promise<void> {
    const screen = this.currentScreen
    if (!screen || this.actionInFlight) return

    const selectedItem = this.filtered[this.selectedIndex] ?? null
    const result = await screen.onEnter({
      selectedItem,
      searchValue: this.searchInput.value,
      selectedIndex: this.selectedIndex,
    })

    await this.handleResult(result)
  }

  private async handleClick(index: number): Promise<void> {
    const screen = this.currentScreen
    if (!screen || this.actionInFlight) return

    const item = this.filtered[index]
    if (!item) return

    this.selectedIndex = index
    this.updateActiveItem()

    if (screen.onClick) {
      const result = await screen.onClick({ item, index })
      await this.handleResult(result)
    } else {
      const result = await screen.onEnter({
        selectedItem: item,
        searchValue: this.searchInput.value,
        selectedIndex: index,
      })
      await this.handleResult(result)
    }
  }

  private async handleKeyDown(event: KeyboardEvent): Promise<void> {
    if (event.defaultPrevented) return

    if (event.key === 'Escape') {
      event.preventDefault()
      this.pop()
      return
    }

    const screen = this.currentScreen
    const canNavigate = screen?.navigable ?? false

    if (canNavigate && (event.key === 'ArrowDown' || event.key === 'Down' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j'))) {
      event.preventDefault()
      this.selectNext()
      return
    }

    if (canNavigate && (event.key === 'ArrowUp' || event.key === 'Up' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
      event.preventDefault()
      this.selectPrev()
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      await this.handleEnterKey()
    }
  }

  private bindEvents(): void {
    this.searchInput.addEventListener('keydown', (event) => {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'Down' ||
        event.key === 'ArrowUp' ||
        event.key === 'Up' ||
        event.key === 'Enter' ||
        event.key === 'Escape'
      ) {
        void this.handleKeyDown(event)
      }
    }, true)

    window.addEventListener('keydown', (event) => {
      if (event.target === this.searchInput) return
      void this.handleKeyDown(event)
    }, true)

    this.resultsEl.addEventListener('mouseover', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const itemEl = target.closest('.item')
      if (!(itemEl instanceof HTMLElement)) return
      const index = Number(itemEl.dataset.index)
      if (!Number.isFinite(index) || index === this.selectedIndex) return
      this.selectedIndex = index
      this.updateActiveItem()
    })

    this.resultsEl.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const itemEl = target.closest('.item')
      if (!(itemEl instanceof HTMLElement)) return
      event.preventDefault()
      const index = Number(itemEl.dataset.index)
      if (!Number.isFinite(index)) return
      void this.handleClick(index)
    })

    this.searchInput.addEventListener('input', () => {
      const screen = this.currentScreen
      if (!screen) return

      if (screen.searchIsFilter) {
        this.selectedIndex = 0
        this.applyFilter()
      } else if (screen.renderContent) {
        // For screens with custom content (editing), re-render to clear errors etc.
        this.render()
      }
    })
  }
}
