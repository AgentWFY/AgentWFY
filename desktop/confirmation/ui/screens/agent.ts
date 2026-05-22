import type { ConfirmationScreen } from '../screen.js'

export function agentInstallScreen(params: Record<string, unknown>): ConfirmationScreen {
  const viewsCount = (params.viewsCount as number) || 0
  const docsCount = (params.docsCount as number) || 0
  const tasksCount = (params.tasksCount as number) || 0
  const pluginsCount = (params.pluginsCount as number) || 0

  let selectedDirectory: string | null = null

  return {
    title: 'Install Agent',
    confirmLabel: 'Install',
    renderBody(container) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'font-size: 13px; color: var(--text); line-height: 1.6;'

      // Contents summary
      const parts: string[] = []
      if (viewsCount > 0) parts.push(`${viewsCount} view${viewsCount !== 1 ? 's' : ''}`)
      if (docsCount > 0) parts.push(`${docsCount} doc${docsCount !== 1 ? 's' : ''}`)
      if (tasksCount > 0) parts.push(`${tasksCount} task${tasksCount !== 1 ? 's' : ''}`)
      if (pluginsCount > 0) parts.push(`${pluginsCount} plugin${pluginsCount !== 1 ? 's' : ''}`)

      if (parts.length > 0) {
        const summary = document.createElement('div')
        summary.style.cssText = 'margin-bottom: 12px;'
        summary.textContent = `Contains: ${parts.join(', ')}`
        wrap.appendChild(summary)
      }

      // Directory picker
      const dirLabel = document.createElement('div')
      dirLabel.style.cssText = 'margin-bottom: 6px; font-weight: 500;'
      dirLabel.textContent = 'Install directory:'
      wrap.appendChild(dirLabel)

      const dirRow = document.createElement('div')
      dirRow.style.cssText = 'display: flex; gap: 8px; align-items: center;'

      const pathDisplay = document.createElement('div')
      pathDisplay.style.cssText = 'flex: 1; padding: 6px 10px; font-size: 12px; font-family: var(--font-mono, monospace); background: var(--surface, #2a2a2a); border: 1px solid var(--border, #444); border-radius: 4px; color: var(--text-muted, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 28px;'
      pathDisplay.textContent = 'No directory selected'

      const browseBtn = document.createElement('button')
      browseBtn.style.cssText = 'padding: 6px 12px; font-size: 12px; font-family: inherit; border-radius: 4px; border: 1px solid var(--border, #444); background: var(--surface, #2a2a2a); color: var(--text, #ccc); cursor: pointer; white-space: nowrap;'
      browseBtn.textContent = 'Browse...'
      browseBtn.addEventListener('click', async () => {
        const dir = await window.confirmationBridge.pickDirectory()
        if (dir) {
          selectedDirectory = dir
          pathDisplay.textContent = dir
          pathDisplay.style.color = 'var(--text, #ccc)'
        }
      })

      dirRow.appendChild(pathDisplay)
      dirRow.appendChild(browseBtn)
      wrap.appendChild(dirRow)

      container.appendChild(wrap)
    },
    getData() {
      if (!selectedDirectory) return null
      return { directoryPath: selectedDirectory }
    },
  }
}
