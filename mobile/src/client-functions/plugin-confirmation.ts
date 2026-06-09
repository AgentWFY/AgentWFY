import type { PluginConfirmationHost } from '#shared/runtime/client-function-registry.js'
import { requestConfirmation } from '../components/util.js'

interface PluginMeta {
  name: string
  title: string | null
  description: string | null
  version: string | null
  author: string | null
  license: string | null
}

export function createMobilePluginConfirmationHost(): PluginConfirmationHost {
  return {
    confirmPluginInstall(_packagePath, plugins) {
      return confirmPluginInstall(plugins.map(normalizePluginMeta))
    },
    confirmPluginToggle(plugin) {
      return confirmPluginToggle(normalizePluginMeta(plugin), plugin.currentEnabled)
    },
    confirmPluginUninstall(plugin) {
      return confirmPluginUninstall(normalizePluginMeta(plugin))
    },
  }
}

function confirmPluginInstall(plugins: PluginMeta[]): Promise<boolean> {
  const count = plugins.length
  return requestConfirmation({
    title: count === 1 ? 'Install Plugin' : `Install ${count} Plugins`,
    message: count === 1
      ? 'Review this plugin before installing it.'
      : 'Review these plugins before installing them.',
    confirmLabel: 'Install',
    renderBody(container) {
      renderPluginList(container, plugins)
    },
  })
}

function confirmPluginToggle(plugin: PluginMeta, currentEnabled: boolean): Promise<boolean> {
  const action = currentEnabled ? 'Disable' : 'Enable'
  return requestConfirmation({
    title: `${action} Plugin`,
    message: `${action} this plugin?`,
    confirmLabel: action,
    renderBody(container) {
      container.appendChild(createPluginCard(plugin))
    },
  })
}

function confirmPluginUninstall(plugin: PluginMeta): Promise<boolean> {
  return requestConfirmation({
    title: 'Uninstall Plugin',
    message: 'This will remove the plugin and its docs.',
    confirmLabel: 'Uninstall',
    danger: true,
    renderBody(container) {
      container.appendChild(createPluginCard(plugin))
    },
  })
}

function renderPluginList(container: HTMLElement, plugins: PluginMeta[]): void {
  if (plugins.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'confirm-plugin-empty'
    empty.textContent = 'No plugin metadata was provided.'
    container.appendChild(empty)
    return
  }
  for (const plugin of plugins) container.appendChild(createPluginCard(plugin))
}

function createPluginCard(plugin: PluginMeta): HTMLElement {
  const card = document.createElement('div')
  card.className = 'confirm-plugin-card'

  const header = document.createElement('div')
  header.className = 'confirm-plugin-header'

  const name = document.createElement('div')
  name.className = 'confirm-plugin-name'
  name.textContent = plugin.title || plugin.name
  header.appendChild(name)

  if (plugin.version) {
    const version = document.createElement('span')
    version.className = 'confirm-plugin-version'
    version.textContent = `v${plugin.version}`
    header.appendChild(version)
  }
  card.appendChild(header)

  if (plugin.title && plugin.title !== plugin.name) {
    const rawName = document.createElement('div')
    rawName.className = 'confirm-plugin-raw-name'
    rawName.textContent = plugin.name
    card.appendChild(rawName)
  }

  if (plugin.description) {
    const description = document.createElement('div')
    description.className = 'confirm-plugin-description'
    description.textContent = plugin.description
    card.appendChild(description)
  }

  const metaParts = [plugin.author, plugin.license].filter((part): part is string => part !== null)
  if (metaParts.length > 0) {
    const meta = document.createElement('div')
    meta.className = 'confirm-plugin-meta'
    meta.textContent = metaParts.join(' \u00b7 ')
    card.appendChild(meta)
  }

  return card
}

function normalizePluginMeta(value: unknown): PluginMeta {
  const raw = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  const name = stringValue(raw.pluginName) ?? stringValue(raw.name) ?? 'Unknown plugin'
  return {
    name,
    title: stringValue(raw.title),
    description: stringValue(raw.description),
    version: stringValue(raw.version),
    author: stringValue(raw.author),
    license: stringValue(raw.license),
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
