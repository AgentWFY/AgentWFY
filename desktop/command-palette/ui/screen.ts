import type { CommandPaletteItem } from '../types.js'

export interface PaletteScreen {
  id: string
  breadcrumb: string | null
  placeholder: string
  emptyText: string
  hints: Array<{ key: string; label: string }>

  getItems(): Promise<CommandPaletteItem[]> | CommandPaletteItem[]

  searchIsFilter: boolean
  navigable: boolean
  initialSearchValue?: string

  /** Heading rendered above the search field — for a screen that asks something
   *  too long to live inside a placeholder. */
  prompt?: string
  /** Hide the filter field; a short list reads better without one. */
  hideSearch?: boolean

  renderContent?(container: HTMLElement): void
  /** Runs after every render pass, including the empty state. Measure here. */
  afterRender?(container: HTMLElement): void
  saveAll?(): Promise<void>

  /** First look at a key event. Return null to fall through to default handling. */
  onKeyDown?(event: KeyboardEvent): Promise<ScreenResult | null> | ScreenResult | null

  onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult>
  onClick?(ctx: { item: CommandPaletteItem; index: number }): Promise<ScreenResult>

  onActivate?(): void
  onDeactivate?(): void
  onExternalUpdate?(detail: { key: string; value: unknown }): void
}

export type ScreenResult =
  | { type: 'push'; screen: PaletteScreen }
  | { type: 'pop'; count?: number }
  | { type: 'close' }
  | { type: 'action'; action: unknown }
  | { type: 'none' }
