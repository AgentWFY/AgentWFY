import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

export interface TaskDetailParams {
  taskId: number
  taskName: string
  taskDescription?: string
}

export class TaskDetailScreen implements PaletteScreen {
  readonly id = 'task-detail'
  readonly breadcrumb: string
  readonly placeholder = 'Type input and press Enter to run...'
  readonly emptyText = 'No matches'
  readonly hints = [
    { key: 'Enter', label: 'run' },
    { key: 'Esc', label: 'back' },
  ]
  readonly searchIsFilter = false
  readonly navigable = false

  private readonly bridge: CommandPaletteBridge
  private readonly params: TaskDetailParams

  constructor(bridge: CommandPaletteBridge, params: TaskDetailParams) {
    this.bridge = bridge
    this.params = params
    this.breadcrumb = params.taskName
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
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null; searchValue: string; selectedIndex: number }): Promise<ScreenResult> {
    const inputValue = ctx.searchValue.trim()
    return {
      type: 'action',
      action: {
        type: 'run-task',
        taskId: this.params.taskId,
        taskName: this.params.taskName,
        input: inputValue || undefined,
      },
    }
  }
}
