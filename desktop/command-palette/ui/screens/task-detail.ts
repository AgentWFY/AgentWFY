import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'
import { createActionButtons } from '../helpers.js'

export interface TaskDetailParams {
  taskName: string
  taskTitle: string
  taskDescription?: string
}

export class TaskDetailScreen implements PaletteScreen {
  readonly id = 'task-detail'
  readonly breadcrumb: string
  readonly placeholder = 'Type input for the task\u2026'
  readonly emptyText = 'No matches'
  readonly hints = [
    { key: 'Enter', label: 'run' },
    { key: 'Esc', label: 'back' },
  ]
  readonly searchIsFilter = false
  readonly navigable = false

  private readonly params: TaskDetailParams

  constructor(_bridge: CommandPaletteBridge, params: TaskDetailParams) {
    this.params = params
    this.breadcrumb = params.taskTitle
  }

  getItems(): CommandPaletteItem[] {
    return []
  }

  renderContent(container: HTMLElement): void {
    if (this.params.taskDescription) {
      const descEl = document.createElement('div')
      descEl.className = 'edit-description'
      descEl.textContent = this.params.taskDescription
      container.appendChild(descEl)
    }

    container.appendChild(createActionButtons('Run'))
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    const inputValue = ctx.searchValue.trim()
    return {
      type: 'action',
      action: {
        type: 'run-task',
        taskName: this.params.taskName,
        taskTitle: this.params.taskTitle,
        input: inputValue || undefined,
      },
    }
  }
}
