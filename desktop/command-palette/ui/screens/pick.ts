import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

export interface PickScreenParams {
  /** The question the agent is asking. */
  question?: string
  placeholder?: string
  /** Item count, known before the list loads, so the layout is decided once. */
  count?: number
}

/** At or below this many options the filter field is noise — the whole list is
 *  on screen. Keep it under 10 so every row an unfiltered list shows has a
 *  digit shortcut. */
const FILTER_THRESHOLD = 8

const MIN_HEIGHT = 140
const MAX_HEIGHT = 560

export class PickScreen implements PaletteScreen {
  readonly id = 'pick'
  /** Null: this is a root screen with its own heading, not a drill-down. */
  readonly breadcrumb = null
  readonly placeholder: string
  readonly emptyText = 'No matching options'
  readonly prompt: string | undefined
  readonly hideSearch: boolean
  readonly hints: Array<{ key: string; label: string }>
  readonly searchIsFilter = true
  readonly navigable = true

  private readonly bridge: CommandPaletteBridge
  private itemCount: number

  constructor(bridge: CommandPaletteBridge, params?: PickScreenParams) {
    this.bridge = bridge
    const question = params?.question?.trim()
    this.prompt = question || undefined
    this.itemCount = typeof params?.count === 'number' ? params.count : 0
    this.hideSearch = this.itemCount > 0 && this.itemCount <= FILTER_THRESHOLD
    this.placeholder = params?.placeholder?.trim() || 'Filter options…'
    this.hints = [
      ...(this.hideSearch ? [{ key: '1-9', label: 'pick' }] : []),
      { key: '↑↓', label: 'navigate' },
      { key: '↵', label: 'select' },
      { key: 'Esc', label: 'cancel' },
    ]
  }

  async getItems(): Promise<CommandPaletteItem[]> {
    try {
      const items = await this.bridge.listPickItems()
      this.itemCount = items.length
      return items
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

  /** Digit keys pick directly. Only reachable while the filter field is hidden —
   *  otherwise digits are the user typing a query. */
  async onKeyDown(event: KeyboardEvent): Promise<ScreenResult | null> {
    if (!this.hideSearch || event.metaKey || event.ctrlKey || event.altKey) return null
    if (!/^[1-9]$/.test(event.key)) return null

    const index = Number(event.key) - 1
    if (index >= this.itemCount) return null

    event.preventDefault()
    await this.bridge.resolvePick(index)
    return { type: 'none' }
  }

  /** Size the window to the question and the options rather than leaving a
   *  half-empty default-sized box. */
  afterRender(container: HTMLElement): void {
    const palette = document.querySelector('.palette')
    if (!(palette instanceof HTMLElement)) return

    // `.results` is the only flexible row, so everything else is fixed overhead.
    const overhead = palette.offsetHeight - container.offsetHeight
    // A flexed box never reports a height below the space it was given —
    // scrollHeight included — so take flex off it just long enough to read
    // what the options actually need.
    const previousFlex = container.style.flex
    container.style.flex = '0 0 auto'
    const contentHeight = container.offsetHeight
    container.style.flex = previousFlex

    const height = Math.max(MIN_HEIGHT, Math.min(overhead + contentHeight, MAX_HEIGHT))
    // Width is left alone: changing it would re-wrap the question and
    // invalidate the height just measured.
    void this.bridge.resize({ width: palette.offsetWidth, height })
  }

  onDeactivate(): void {
    void this.bridge.resize({ width: 0, height: 0 })
  }
}
