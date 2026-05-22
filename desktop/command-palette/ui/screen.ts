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

  renderContent?(container: HTMLElement): void
  saveAll?(): Promise<void>

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
