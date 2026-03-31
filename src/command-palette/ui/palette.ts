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
    if (current && current.id === 'settings') {
      void this.loadAndRenderItems()
    }
  }

  private async activateScreen(): Promise<void> {
    const screen = this.currentScreen
    if (!screen) return

    screen.onActivate?.()

    // Update breadcrumb
    if (screen.breadcrumb) {
      this.breadcrumbEl.className = 'breadcrumb visible'
      this.breadcrumbEl.innerHTML = ''
      const backBtn = document.createElement('button')
      backBtn.className = 'bc-back'
      backBtn.type = 'button'
      backBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>'
      backBtn.addEventListener('click', () => this.pop())
      this.breadcrumbEl.appendChild(backBtn)
      const segments = screen.breadcrumb.split('\u203A').map(s => s.trim()).filter(Boolean)
      segments.forEach((seg, i) => {
        const span = document.createElement('span')
        span.className = i === segments.length - 1 ? 'bc-segment current' : 'bc-segment'
        span.textContent = seg
        this.breadcrumbEl.appendChild(span)
        if (i < segments.length - 1) {
          const sep = document.createElement('span')
          sep.className = 'bc-sep'
          sep.textContent = '\u203A'
          this.breadcrumbEl.appendChild(sep)
        }
      })
    } else {
      this.breadcrumbEl.className = 'breadcrumb'
      this.breadcrumbEl.innerHTML = ''
    }

    // Update hints
    this.hintBar.innerHTML = screen.hints
      .map(h => `<span class="hint-item"><span class="hint-key">${h.key}</span> ${h.label}</span>`)
      .join('')

    // Update search
    this.searchInput.placeholder = screen.placeholder
    this.searchInput.value = ''
    if (screen.initialSearchValue !== undefined) {
      this.searchInput.value = screen.initialSearchValue
    }

    this.selectedIndex = 0

    await this.loadAndRenderItems()

    this.searchInput.focus()
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

  private static readonly TYPE_LABELS: Record<string, string> = {
    'Views': 'view',
    'System Views': 'system',
    'Plugin Views': 'plugin',
  }

  private render(): void {
    const screen = this.currentScreen
    if (!screen) return

    this.resultsEl.innerHTML = ''

    if (screen.renderContent && this.filtered.length === 0) {
      screen.renderContent(this.resultsEl)
      this.bindActionButtons()
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

    const showTypeLabels = screen.breadcrumb === null
    const uniqueGroups = new Set(this.filtered.map(i => i.group))
    const showSectionHeaders = screen.breadcrumb !== null && uniqueGroups.size > 1
    const isSettingsLayout = this.filtered.some(i => i.settingValue !== undefined && i.settingValue !== 'current')

    let lastGroup = ''
    this.filtered.forEach((item, index) => {
      if (item.group !== lastGroup) {
        if (showSectionHeaders) {
          // Section header label
          const label = document.createElement('div')
          label.className = 'section-label'
          label.textContent = item.group
          this.resultsEl.appendChild(label)
        } else if (lastGroup !== '') {
          // Thin separator between groups
          const sep = document.createElement('div')
          sep.className = 'sep'
          this.resultsEl.appendChild(sep)
        }
      }
      lastGroup = item.group

      const itemButton = document.createElement('button')
      itemButton.type = 'button'
      const hasDesc = !!item.subtitle
      const isSettingRow = isSettingsLayout && item.settingValue !== undefined
      itemButton.className = 'item' + (index === this.selectedIndex ? ' active' : '') + (hasDesc ? ' has-desc' : '') + (isSettingRow ? ' setting-row' : '')
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

      if (showTypeLabels) {
        const typeLabel = PaletteController.TYPE_LABELS[item.group]
        if (typeLabel) {
          const typeEl = document.createElement('span')
          typeEl.className = 'item-type'
          typeEl.textContent = typeLabel
          itemButton.appendChild(typeEl)
        }
      }

      if (item.settingValue !== undefined) {
        if (item.settingValue === 'current') {
          const checkEl = document.createElement('span')
          checkEl.className = 'item-check'
          checkEl.textContent = '\u2713'
          itemButton.appendChild(checkEl)
        } else {
          const valueWrap = document.createElement('span')
          valueWrap.className = 'setting-value'

          if (item.settingSource) {
            const sourceEl = document.createElement('span')
            sourceEl.className = 'setting-source'
            sourceEl.textContent = item.settingSource
            valueWrap.appendChild(sourceEl)
            valueWrap.appendChild(document.createTextNode(' '))
          }

          valueWrap.appendChild(document.createTextNode(item.settingValue || '(empty)'))
          itemButton.appendChild(valueWrap)
        }
      }

      if (item.shortcut) {
        const shortcutEl = document.createElement('span')
        shortcutEl.className = 'item-shortcut'
        shortcutEl.textContent = item.shortcut
        itemButton.appendChild(shortcutEl)
      }

      if (item.expandable) {
        const chevronEl = document.createElement('span')
        chevronEl.className = 'item-chevron'
        chevronEl.textContent = '\u203A'
        itemButton.appendChild(chevronEl)
      }

      this.resultsEl.appendChild(itemButton)
    })

    if (screen.renderContent) {
      screen.renderContent(this.resultsEl)
      this.bindActionButtons()
    }
  }

  private bindActionButtons(): void {
    const screen = this.currentScreen
    const saveBtn = this.resultsEl.querySelector('[data-action="save"]')
    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault()
        if (screen?.saveAll) {
          void screen.saveAll().then(() => this.render())
        } else {
          void this.handleEnterKey()
        }
      })
    }
    const cancelBtn = this.resultsEl.querySelector('[data-action="cancel"]')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.preventDefault()
        this.pop()
      })
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
      case 'pop': {
        const count = result.count ?? 1
        for (let i = 0; i < count; i++) this.pop()
        break
      }
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

    if (canNavigate && (event.key === 'ArrowDown' || event.key === 'Down' || (event.ctrlKey && (event.key.toLowerCase() === 'j' || event.key.toLowerCase() === 'n')))) {
      event.preventDefault()
      this.selectNext()
      return
    }

    if (canNavigate && (event.key === 'ArrowUp' || event.key === 'Up' || (event.ctrlKey && (event.key.toLowerCase() === 'k' || event.key.toLowerCase() === 'p')))) {
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
      const isCtrlNav = event.ctrlKey && 'jknp'.includes(event.key.toLowerCase())
      if (
        event.key === 'ArrowDown' ||
        event.key === 'Down' ||
        event.key === 'ArrowUp' ||
        event.key === 'Up' ||
        event.key === 'Enter' ||
        event.key === 'Escape' ||
        isCtrlNav
      ) {
        void this.handleKeyDown(event)
      }
    }, true)

    window.addEventListener('keydown', (event) => {
      if (event.target === this.searchInput) return
      if (event.target instanceof HTMLInputElement && event.target.classList.contains('settings-card-input')) {
        if (event.key === 'Escape') {
          event.preventDefault()
          this.pop()
        }
        return
      }
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
        // Re-render for screens with custom content (settings form)
        this.render()
      }
    })
  }
}
