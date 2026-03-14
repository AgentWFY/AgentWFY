import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'
import { SettingsScreen } from './settings.js'
import { RestoreScreen } from './restore.js'
import { TaskDetailScreen } from './task-detail.js'

export class NormalScreen implements PaletteScreen {
  readonly id = 'normal'
  readonly breadcrumb: string | null = null
  readonly placeholder = 'Search...'
  readonly emptyText = 'No matches'
  readonly hints = [
    { key: 'Enter', label: 'run' },
    { key: 'Esc', label: 'close' },
    { key: '\u2191\u2193', label: 'navigate' },
  ]
  readonly searchIsFilter = true
  readonly navigable = true

  private readonly bridge: CommandPaletteBridge
  readonly initialSearchValue?: string

  constructor(bridge: CommandPaletteBridge, filter?: string) {
    this.bridge = bridge
    if (filter) {
      this.initialSearchValue = filter
    }
  }

  async getItems(): Promise<CommandPaletteItem[]> {
    try {
      return await this.bridge.listItems()
    } catch (error) {
      console.error('Failed to list command palette items:', error)
      return []
    }
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    const item = ctx.selectedItem
    if (!item) return { type: 'none' }

    if (item.action.type === 'enter-settings') {
      return { type: 'push', screen: new SettingsScreen(this.bridge) }
    }

    if (item.action.type === 'restore-agent-db') {
      return { type: 'push', screen: new RestoreScreen(this.bridge) }
    }

    if (item.action.type === 'run-task') {
      return {
        type: 'push',
        screen: new TaskDetailScreen(this.bridge, {
          taskId: item.action.taskId,
          taskName: item.action.taskName,
          taskDescription: item.action.taskDescription,
        }),
      }
    }

    if (item.action.type === 'open-settings-file') {
      try {
        await this.bridge.openSettingsFile()
      } catch (error) {
        console.error('Failed to open settings file:', error)
      }
      return { type: 'close' }
    }

    return { type: 'action', action: item.action }
  }
}
