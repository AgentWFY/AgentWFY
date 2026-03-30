import type { CommandPaletteBridge } from './bridge.js'
import type { PaletteScreen } from './screen.js'
import { PaletteController } from './palette.js'
import { NormalScreen } from './screens/normal.js'
import { SettingsScreen } from './screens/settings.js'
import { RestoreScreen } from './screens/restore.js'
import { TaskDetailScreen } from './screens/task-detail.js'
import type { TaskDetailParams } from './screens/task-detail.js'
import { SessionsScreen } from './screens/sessions.js'

declare global {
  interface Window {
    commandPaletteBridge: CommandPaletteBridge
  }
}

const screenRegistry: Record<string, (bridge: CommandPaletteBridge, params?: Record<string, unknown>) => PaletteScreen> = {
  'normal': (bridge, params) => new NormalScreen(bridge, params?.filter as string | undefined),
  'settings': (bridge) => new SettingsScreen(bridge),
  'restore': (bridge) => new RestoreScreen(bridge),
  'task-detail': (bridge, params) => new TaskDetailScreen(bridge, params as unknown as TaskDetailParams),
  'sessions': (bridge) => new SessionsScreen(bridge),
}

function init(): void {
  const bridge = window.commandPaletteBridge
  const searchInput = document.getElementById('searchInput') as HTMLInputElement
  const resultsEl = document.getElementById('results')!
  const breadcrumbEl = document.getElementById('breadcrumb')!
  const hintBar = document.getElementById('hintBar')!

  const controller = new PaletteController(bridge, {
    searchInput,
    resultsEl,
    breadcrumbEl,
    hintBar,
  })

  const openAtNormal = (filter?: string) => {
    controller.reset(new NormalScreen(bridge, filter))
  }

  const openAtScreen = (options: { screen?: string; params?: Record<string, unknown> }) => {
    const screenId = options.screen || 'normal'
    const factory = screenRegistry[screenId]

    if (!factory) {
      openAtNormal()
      return
    }

    // Always start with NormalScreen as base so Escape goes back to normal
    if (screenId !== 'normal') {
      const normalScreen = new NormalScreen(bridge)
      const targetScreen = factory(bridge, options.params)
      controller.resetAndPush(normalScreen, targetScreen)
    } else {
      controller.reset(factory(bridge, options.params))
    }
  }

  // Bridge event listeners
  bridge.onOpened(() => {
    openAtNormal()
  })

  bridge.onOpenedWithFilter((query) => {
    openAtNormal(query)
  })

  bridge.onOpenedAtScreen((options) => {
    openAtScreen(options)
  })

  const unsubSettingChanged = bridge.onSettingChanged((detail) => {
    controller.handleSettingChanged(detail)
  })

  window.addEventListener('beforeunload', () => {
    unsubSettingChanged()
  })

  // Initial load
  openAtNormal()
}

init()
