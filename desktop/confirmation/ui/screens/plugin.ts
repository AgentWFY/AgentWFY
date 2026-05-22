import type { ConfirmationScreen } from '../screen.js'

function pluginCard(opts: {
  name: string
  title?: string | null
  version?: string | null
  description?: string | null
  author?: string | null
  license?: string | null
}): HTMLElement {
  const card = document.createElement('div')
  card.className = 'plugin-card'

  const header = document.createElement('div')
  header.className = 'plugin-name'
  header.textContent = opts.title || opts.name
  if (opts.version) {
    const ver = document.createElement('span')
    ver.className = 'plugin-version'
    ver.textContent = `v${opts.version}`
    header.appendChild(ver)
  }
  card.appendChild(header)

  if (opts.description) {
    const desc = document.createElement('div')
    desc.className = 'plugin-description'
    desc.textContent = opts.description
    card.appendChild(desc)
  }

  const metaParts: string[] = []
  if (opts.author) metaParts.push(opts.author)
  if (opts.license) metaParts.push(opts.license)
  if (metaParts.length) {
    const meta = document.createElement('div')
    meta.className = 'plugin-meta'
    meta.textContent = metaParts.join(' \u00b7 ')
    card.appendChild(meta)
  }

  return card
}

export function pluginInstallScreen(params: Record<string, unknown>): ConfirmationScreen {
  const plugins = params.plugins as Array<{ name: string; title?: string; description: string; version: string; author?: string | null; repository?: string | null; license?: string | null }>
  return {
    title: plugins.length === 1 ? 'Install Plugin' : `Install ${plugins.length} Plugins`,
    confirmLabel: 'Install',
    renderBody(container) {
      for (const p of plugins) {
        container.appendChild(pluginCard({
          name: p.name,
          title: p.title,
          version: p.version,
          description: p.description,
          author: p.author,
          license: p.license,
        }))
      }
    },
  }
}

function singlePluginCard(params: Record<string, unknown>): HTMLElement {
  return pluginCard({
    name: params.pluginName as string,
    title: params.title as string | undefined,
    version: params.version as string | undefined,
    description: params.description as string | undefined,
    author: params.author as string | undefined,
    license: params.license as string | undefined,
  })
}

export function pluginToggleScreen(params: Record<string, unknown>): ConfirmationScreen {
  const action = (params.currentEnabled as boolean) ? 'Disable' : 'Enable'
  return {
    title: `${action} Plugin`,
    confirmLabel: action,
    renderBody(container) {
      container.appendChild(singlePluginCard(params))
    },
  }
}

export function pluginUninstallScreen(params: Record<string, unknown>): ConfirmationScreen {
  return {
    title: 'Uninstall Plugin',
    confirmLabel: 'Uninstall',
    renderBody(container) {
      container.appendChild(singlePluginCard(params))
      const warning = document.createElement('div')
      warning.className = 'plugin-warning'
      warning.textContent = 'This will remove the plugin and its docs.'
      container.appendChild(warning)
    },
  }
}
