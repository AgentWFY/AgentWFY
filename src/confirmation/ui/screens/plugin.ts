import type { ConfirmationScreen } from '../screen.js'

function infoDiv(lines: string[]): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = 'font-size: 13px; color: var(--text); line-height: 1.6; white-space: pre-wrap;'
  el.textContent = lines.join('\n')
  return el
}

function metaLine(author?: string | null, license?: string | null): string | null {
  const parts: string[] = []
  if (author) parts.push(`Author: ${author}`)
  if (license) parts.push(`License: ${license}`)
  return parts.length ? parts.join(' \u00b7 ') : null
}

export function pluginInstallScreen(params: Record<string, unknown>): ConfirmationScreen {
  const plugins = params.plugins as Array<{ name: string; description: string; version: string; author?: string | null; repository?: string | null; license?: string | null }>
  return {
    title: 'Install Plugin',
    confirmLabel: 'Install',
    renderBody(container) {
      const lines = plugins.map(p => {
        let text = `${p.name} v${p.version}`
        if (p.description) text += ` \u2014 ${p.description}`
        const meta = metaLine(p.author, p.license)
        if (meta) text += `\n  ${meta}`
        return text
      })
      container.appendChild(infoDiv(lines))
    },
  }
}

export function pluginToggleScreen(params: Record<string, unknown>): ConfirmationScreen {
  const pluginName = params.pluginName as string
  const currentEnabled = params.currentEnabled as boolean
  const description = params.description as string | undefined
  const version = params.version as string | undefined
  const author = params.author as string | undefined
  const license = params.license as string | undefined
  const action = currentEnabled ? 'Disable' : 'Enable'

  return {
    title: `${action} Plugin`,
    confirmLabel: action,
    renderBody(container) {
      const lines: string[] = []
      let header = pluginName
      if (version) header += ` v${version}`
      lines.push(header)
      if (description) lines.push(description)
      const meta = metaLine(author, license)
      if (meta) lines.push(meta)
      container.appendChild(infoDiv(lines))
    },
  }
}

export function pluginUninstallScreen(params: Record<string, unknown>): ConfirmationScreen {
  const pluginName = params.pluginName as string
  const description = params.description as string | undefined
  const version = params.version as string | undefined
  const author = params.author as string | undefined
  const license = params.license as string | undefined

  return {
    title: 'Uninstall Plugin',
    confirmLabel: 'Uninstall',
    renderBody(container) {
      const lines: string[] = []
      let header = pluginName
      if (version) header += ` v${version}`
      lines.push(header)
      if (description) lines.push(description)
      const meta = metaLine(author, license)
      if (meta) lines.push(meta)
      lines.push('')
      lines.push('This will remove the plugin and its docs.')
      container.appendChild(infoDiv(lines))
    },
  }
}
