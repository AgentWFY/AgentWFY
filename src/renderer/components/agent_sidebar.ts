import type { InstalledAgent } from '../ipc-types/index.js'

const PLUS_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <line x1="12" y1="5" x2="12" y2="19"/>
  <line x1="5" y1="12" x2="19" y2="12"/>
</svg>`

export class TlAgentSidebar extends HTMLElement {
  private agents: InstalledAgent[] = []
  private listEl!: HTMLDivElement
  private unlistenSwitched: (() => void) | null = null
  private dragSourceIndex: number = -1
  private dropTargetIndex: number = -1

  connectedCallback() {
    const shadow = this.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = `
      :host {
        display: flex;
        flex-direction: column;
        width: 78px;
        min-width: 78px;
        flex-shrink: 0;
        background: var(--color-chrome-bg);
        box-sizing: border-box;
        user-select: none;
        -webkit-app-region: drag;
        overflow: hidden;
      }
      .agent-list {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        flex: 1;
        width: 100%;
        padding-top: 44px;
        padding-bottom: 4px;
        overflow-y: auto;
        overflow-x: hidden;
      }
      :host-context(html.traffic-lights-hidden) .agent-list {
        padding-top: 4px;
      }
      .agent-list::-webkit-scrollbar {
        width: 0;
      }
      .agent-item-wrapper {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 40px;
        flex-shrink: 0;
      }
      .agent-indicator {
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 0;
        border-radius: 0 3px 3px 0;
        background: var(--color-text4);
        transition: height 0.15s cubic-bezier(0.2, 0, 0, 1);
      }
      .agent-item-wrapper:hover .agent-indicator {
        height: 16px;
      }
      .agent-item-wrapper.active .agent-indicator {
        height: 28px;
      }
      .agent-item {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--color-agent-item-bg);
        color: var(--color-text3);
        font-family: var(--font-family);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.3px;
        cursor: pointer;
        transition: background 0.12s ease, color 0.12s ease;
        border: none;
        padding: 0;
        -webkit-app-region: no-drag;
        outline: none;
      }
      .agent-item:hover {
        background: var(--color-accent);
        color: #fff;
      }
      .agent-item-wrapper.active .agent-item {
        background: var(--color-accent);
        color: #fff;
      }
      .agent-item-wrapper.uninitialized .agent-item {
        background: transparent;
        border: 1.5px dashed var(--color-text2);
        color: var(--color-text2);
        opacity: 0.5;
      }
      .agent-item-wrapper.uninitialized:hover .agent-item {
        opacity: 1;
      }
      .separator {
        width: 24px;
        height: 1.5px;
        border-radius: 1px;
        background: var(--color-border);
        flex-shrink: 0;
      }
      .add-btn-wrapper {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 40px;
        flex-shrink: 0;
      }
      .add-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--color-agent-item-bg);
        color: var(--color-text2);
        cursor: pointer;
        transition: background 0.12s ease, color 0.12s ease;
        border: none;
        padding: 0;
        -webkit-app-region: no-drag;
        outline: none;
      }
      .add-btn:hover {
        background: var(--color-accent);
        color: #fff;
      }
      .agent-item-wrapper.drag-over-above::before {
        content: '';
        position: absolute;
        top: -3px;
        left: 50%;
        transform: translateX(-50%);
        width: 28px;
        height: 2px;
        border-radius: 1px;
        background: var(--color-accent);
      }
      .agent-item-wrapper.drag-over-below::after {
        content: '';
        position: absolute;
        bottom: -3px;
        left: 50%;
        transform: translateX(-50%);
        width: 28px;
        height: 2px;
        border-radius: 1px;
        background: var(--color-accent);
      }
      .agent-item-wrapper.dragging {
        opacity: 0.3;
      }
    `
    shadow.appendChild(style)

    this.listEl = document.createElement('div')
    this.listEl.className = 'agent-list'
    shadow.appendChild(this.listEl)

    this.loadAgents()
    this.subscribeToSwitches()
  }

  disconnectedCallback() {
    this.unlistenSwitched?.()
    this.unlistenSwitched = null
  }

  private async loadAgents() {
    const ipc = window.ipc
    if (!ipc) return
    this.agents = await ipc.agentSidebar.getInstalled()
    this.render()
  }

  private subscribeToSwitches() {
    const ipc = window.ipc
    if (!ipc) return
    this.unlistenSwitched = ipc.agentSidebar.onSwitched((data) => {
      this.agents = data.agents
      this.render()
      // Dispatch global event so all components refresh their agent-specific data
      window.dispatchEvent(new CustomEvent('agentwfy:agent-switched', {
        detail: { agentRoot: data.agentRoot, agents: data.agents },
      }))
    })
  }

  private render() {
    this.listEl.innerHTML = ''

    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i]
      const wrapper = document.createElement('div')
      let cls = 'agent-item-wrapper'
      if (agent.active) cls += ' active'
      if (!agent.initialized) cls += ' uninitialized'
      wrapper.className = cls
      wrapper.draggable = true

      const indicator = document.createElement('div')
      indicator.className = 'agent-indicator'
      wrapper.appendChild(indicator)

      const item = document.createElement('button')
      item.className = 'agent-item'
      item.title = agent.name
      item.appendChild(document.createTextNode(this.getInitials(agent.name)))

      item.addEventListener('click', () => {
        if (!agent.active) window.ipc?.agentSidebar.switch(agent.path)
      })

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        window.ipc?.agentSidebar.showContextMenu(agent.path)
      })

      wrapper.addEventListener('dragstart', (e) => {
        this.dragSourceIndex = i
        wrapper.classList.add('dragging')
        e.dataTransfer!.effectAllowed = 'move'
      })

      wrapper.addEventListener('dragend', () => {
        wrapper.classList.remove('dragging')
        this.clearDropIndicators()
        if (this.dropTargetIndex !== -1 && this.dropTargetIndex !== this.dragSourceIndex) {
          window.ipc?.agentSidebar.reorder(this.dragSourceIndex, this.dropTargetIndex)
        }
        this.dragSourceIndex = -1
        this.dropTargetIndex = -1
      })

      wrapper.addEventListener('dragover', (e) => {
        e.preventDefault()
        e.dataTransfer!.dropEffect = 'move'
        const rect = wrapper.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        this.clearDropIndicators()
        if (e.clientY < midY) {
          wrapper.classList.add('drag-over-above')
          this.dropTargetIndex = i
        } else {
          wrapper.classList.add('drag-over-below')
          this.dropTargetIndex = i + 1
        }
      })

      wrapper.addEventListener('dragleave', () => {
        wrapper.classList.remove('drag-over-above', 'drag-over-below')
      })

      wrapper.appendChild(item)
      this.listEl.appendChild(wrapper)
    }

    const sep = document.createElement('div')
    sep.className = 'separator'
    this.listEl.appendChild(sep)

    const addWrapper = document.createElement('div')
    addWrapper.className = 'add-btn-wrapper'

    const addBtn = document.createElement('button')
    addBtn.className = 'add-btn'
    addBtn.innerHTML = PLUS_ICON

    addBtn.addEventListener('click', () => {
      window.ipc?.commandPalette?.show({ screen: 'add-agent' })
    })

    addWrapper.appendChild(addBtn)
    this.listEl.appendChild(addWrapper)
  }

  private clearDropIndicators() {
    this.listEl.querySelectorAll('.drag-over-above, .drag-over-below').forEach(el => {
      el.classList.remove('drag-over-above', 'drag-over-below')
    })
  }

  private getInitials(name: string): string {
    const parts = name.split(/[-_\s.]+/).filter(Boolean)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase()
    }
    if (name.length >= 2) {
      return name.slice(0, 2).toUpperCase()
    }
    return name.toUpperCase()
  }
}
