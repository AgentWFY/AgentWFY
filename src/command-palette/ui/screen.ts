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
  initialSelectedIndex?: number

  renderContent?(container: HTMLElement): void

  onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult>
  onClick?(ctx: { item: CommandPaletteItem; index: number }): Promise<ScreenResult>

  onActivate?(): void
  onDeactivate?(): void
  onExternalUpdate?(detail: { key: string; value: unknown }): void
}

export type ScreenResult =
  | { type: 'push'; screen: PaletteScreen }
  | { type: 'pop' }
  | { type: 'close' }
  | { type: 'action'; action: unknown }
  | { type: 'none' }
