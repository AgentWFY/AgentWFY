import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'
import { TaskDetailScreen } from './task-detail.js'

export class TasksScreen implements PaletteScreen {
  readonly id = 'tasks'
  readonly breadcrumb = 'Run Task'
  readonly placeholder = 'Filter tasks\u2026'
  readonly emptyText = 'No tasks defined'
  readonly hints = [
    { key: 'Enter', label: 'select' },
    { key: 'Esc', label: 'back' },
    { key: '\u2191\u2193', label: 'navigate' },
  ]
  readonly searchIsFilter = true
  readonly navigable = true

  private readonly bridge: CommandPaletteBridge

  constructor(bridge: CommandPaletteBridge) {
    this.bridge = bridge
  }

  async getItems(): Promise<CommandPaletteItem[]> {
    try {
      return await this.bridge.listTasks()
    } catch (error) {
      console.error('Failed to list tasks:', error)
      return []
    }
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    const item = ctx.selectedItem
    if (!item) return { type: 'none' }

    if (item.action.type === 'run-task') {
      return {
        type: 'push',
        screen: new TaskDetailScreen(this.bridge, {
          taskName: item.action.taskName,
          taskTitle: item.action.taskTitle,
          taskDescription: item.action.taskDescription,
        }),
      }
    }

    return { type: 'none' }
  }
}
