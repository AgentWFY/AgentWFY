import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

const ITEMS: CommandPaletteItem[] = [
  {
    id: 'add-agent:default',
    title: 'Add Default Agent',
    subtitle: 'Create a quick disposable agent',
    group: 'Actions',
    action: { type: 'add-default-agent' },
  },
  {
    id: 'add-agent:directory',
    title: 'Add to Directory',
    subtitle: 'Choose a directory for the agent',
    group: 'Actions',
    action: { type: 'add-agent-to-directory' },
  },
  {
    id: 'add-agent:import',
    title: 'Import from .agent.awfy',
    subtitle: 'Add an agent from a .agent.awfy package',
    group: 'Actions',
    action: { type: 'import-agent-from-file' },
  },
]

export class AddAgentScreen implements PaletteScreen {
  constructor(_bridge: CommandPaletteBridge) {}

  readonly id = 'add-agent'
  readonly breadcrumb = 'Add Agent'
  readonly placeholder = 'Choose how to add an agent\u2026'
  readonly emptyText = 'No matches'
  readonly hints = [
    { key: 'Enter', label: 'select' },
    { key: 'Esc', label: 'back' },
    { key: '\u2191\u2193', label: 'navigate' },
  ]
  readonly searchIsFilter = true
  readonly navigable = true

  getItems(): CommandPaletteItem[] {
    return ITEMS
  }

  async onEnter(ctx: { selectedItem: CommandPaletteItem | null }): Promise<ScreenResult> {
    if (!ctx.selectedItem) return { type: 'none' }
    return { type: 'action', action: ctx.selectedItem.action }
  }
}
