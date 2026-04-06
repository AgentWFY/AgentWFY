import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'
import { SettingsScreen } from './settings.js'
import { RestoreScreen } from './restore.js'
import { TasksScreen } from './tasks.js'
import { SessionsScreen } from './sessions.js'
import { AddAgentScreen } from './add-agent.js'

export class NormalScreen implements PaletteScreen {
  readonly id = 'normal'
  readonly breadcrumb: string | null = null
  readonly placeholder = 'Type a command\u2026'
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

    if (item.action.type === 'enter-tasks') {
      return { type: 'push', screen: new TasksScreen(this.bridge) }
    }

    if (item.action.type === 'enter-sessions') {
      return { type: 'push', screen: new SessionsScreen(this.bridge) }
    }

    if (item.action.type === 'enter-add-agent') {
      return { type: 'push', screen: new AddAgentScreen(this.bridge) }
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
