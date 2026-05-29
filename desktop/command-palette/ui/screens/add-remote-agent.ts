import type { PaletteScreen, ScreenResult } from '../screen.js'
import type { CommandPaletteBridge } from '../bridge.js'
import type { CommandPaletteItem } from '../../types.js'

const SCREEN_WIDTH = 560
const SCREEN_HEIGHT = 420

interface FormState {
  slug: string
  baseUrl: string
  token: string
}

type StatusKind = 'info' | 'ok' | 'fail' | null

export class AddRemoteAgentScreen implements PaletteScreen {
  readonly id = 'add-remote-agent'
  readonly breadcrumb = 'Add Agent › Remote'
  readonly placeholder = ''
  readonly emptyText = ''
  readonly hints: Array<{ key: string; label: string }> = [
    { key: 'Enter', label: 'add' },
    { key: 'Tab', label: 'next field' },
    { key: 'Esc', label: 'back' },
  ]
  readonly searchIsFilter = false
  readonly navigable = false

  private readonly bridge: CommandPaletteBridge
  private state: FormState = { slug: '', baseUrl: '', token: '' }
  private statusText = ''
  private statusKind: StatusKind = null
  private testing = false
  private adding = false
  private container: HTMLElement | null = null

  constructor(bridge: CommandPaletteBridge) {
    this.bridge = bridge
  }

  onActivate(): void {
    void this.bridge.resize({ width: SCREEN_WIDTH, height: SCREEN_HEIGHT })
  }

  onDeactivate(): void {
    void this.bridge.resize({ width: 0, height: 0 })
  }

  getItems(): CommandPaletteItem[] {
    return []
  }

  renderContent(container: HTMLElement): void {
    this.container = container
    container.innerHTML = ''

    container.appendChild(this.renderField({
      key: 'slug',
      label: 'Local label',
      hint: 'Identifier shown in the sidebar. Any short, unique name.',
      placeholder: 'my-remote-agent',
      type: 'text',
      autofocus: true,
    }))

    container.appendChild(this.renderField({
      key: 'baseUrl',
      label: 'Server URL',
      hint: 'The daemon’s HTTP base, no trailing slash. Example: http://vps.example.com:9878',
      placeholder: 'https://your-vps:9878',
      type: 'url',
    }))

    container.appendChild(this.renderField({
      key: 'token',
      label: 'Bearer token',
      hint: 'From agentwfy-server init (or token / rotate).',
      placeholder: '(paste token)',
      type: 'password',
      mono: true,
    }))

    if (this.statusText) {
      const status = document.createElement('div')
      status.className = this.statusKind === 'fail' ? 'edit-error' : 'edit-description'
      if (this.statusKind === 'ok') status.style.color = 'var(--accent)'
      status.textContent = this.statusText
      container.appendChild(status)
    }

    container.appendChild(this.renderActions())
    this.bindEvents(container)
  }

  private renderField(opts: {
    key: keyof FormState
    label: string
    hint: string
    placeholder: string
    type: string
    mono?: boolean
    autofocus?: boolean
  }): HTMLElement {
    const row = document.createElement('div')
    row.className = 'set-row-edit'
    row.style.padding = '8px 14px'

    const label = document.createElement('div')
    label.style.fontSize = '12px'
    label.style.color = 'var(--text-strong)'
    label.textContent = opts.label
    row.appendChild(label)

    const desc = document.createElement('div')
    desc.className = 'set-row-desc'
    desc.textContent = opts.hint
    row.appendChild(desc)

    const input = document.createElement('input')
    input.type = opts.type
    input.className = 'set-row-input'
    input.placeholder = opts.placeholder
    input.spellcheck = false
    input.autocomplete = 'off'
    input.dataset.field = opts.key
    input.value = this.state[opts.key]
    if (opts.mono) input.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace"
    if (opts.autofocus) setTimeout(() => input.focus(), 0)
    row.appendChild(input)

    return row
  }

  private renderActions(): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'actions'

    const testBtn = document.createElement('button')
    testBtn.className = 'btn'
    testBtn.type = 'button'
    testBtn.textContent = this.testing ? 'Testing…' : 'Test connection'
    testBtn.dataset.action = 'test'
    if (this.testing || this.adding) testBtn.setAttribute('disabled', '')
    actions.appendChild(testBtn)

    const addBtn = document.createElement('button')
    addBtn.className = 'btn primary'
    addBtn.type = 'button'
    addBtn.textContent = this.adding ? 'Adding…' : 'Add'
    addBtn.dataset.action = 'save'
    if (this.testing || this.adding) addBtn.setAttribute('disabled', '')
    actions.appendChild(addBtn)

    return actions
  }

  private bindEvents(container: HTMLElement): void {
    container.addEventListener('input', (event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement)) return
      const field = target.dataset.field as keyof FormState | undefined
      if (!field) return
      this.state[field] = target.value
    })

    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      const target = event.target
      if (!(target instanceof HTMLInputElement)) return
      event.preventDefault()
      void this.handleAdd()
    })

    const testBtn = container.querySelector('[data-action="test"]')
    testBtn?.addEventListener('click', (event) => {
      event.preventDefault()
      void this.handleTest()
    })

    const saveBtn = container.querySelector('[data-action="save"]')
    saveBtn?.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.handleAdd()
    })
  }

  private fields(): FormState {
    return {
      slug: this.state.slug.trim(),
      baseUrl: this.state.baseUrl.trim().replace(/\/$/, ''),
      token: this.state.token.trim(),
    }
  }

  private validate(f: FormState): string | null {
    if (!f.slug) return 'Local label is required'
    if (!/^https?:\/\//.test(f.baseUrl)) return 'Server URL must start with http:// or https://'
    if (!f.token) return 'Bearer token is required'
    return null
  }

  private setStatus(text: string, kind: StatusKind): void {
    this.statusText = text
    this.statusKind = kind
    if (this.container) this.renderContent(this.container)
  }

  private async handleTest(): Promise<void> {
    const f = this.fields()
    const err = this.validate(f)
    if (err) { this.setStatus(err, 'fail'); return }
    this.testing = true
    this.setStatus('Testing…', 'info')
    try {
      const body = await wsRpc(f.baseUrl, f.token, 'health')
      if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
        throw new Error('unexpected health response')
      }
      const version = (body as { protocolVersion?: unknown }).protocolVersion
      this.testing = false
      this.setStatus(`Connected (protocol ${version})`, 'ok')
    } catch (e) {
      this.testing = false
      this.setStatus(`Connection failed: ${e instanceof Error ? e.message : String(e)}`, 'fail')
    }
  }

  private async handleAdd(): Promise<ScreenResult | void> {
    if (this.adding) return
    const f = this.fields()
    const err = this.validate(f)
    if (err) { this.setStatus(err, 'fail'); return }
    this.adding = true
    this.setStatus('Adding…', 'info')
    try {
      await this.bridge.runAction({
        type: 'add-remote-agent',
        agentId: f.slug,
        baseUrl: f.baseUrl,
        agentToken: f.token,
      })
    } catch (e) {
      this.adding = false
      this.setStatus(`Failed to add: ${e instanceof Error ? e.message : String(e)}`, 'fail')
    }
  }

  async onEnter(): Promise<ScreenResult> {
    await this.handleAdd()
    return { type: 'none' }
  }

  async saveAll(): Promise<void> {
    await this.handleAdd()
  }
}

function wsUrl(baseUrl: string, token: string): string {
  const proto = baseUrl.startsWith('https:') ? 'wss:' : 'ws:'
  return proto + baseUrl.replace(/^https?:/, '') + '/api/v1/ws?token=' + encodeURIComponent(token)
}

function wsRpc(baseUrl: string, token: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(baseUrl, token))
    const id = 'test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      fail(new Error('connection timed out'))
    }, 10000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'rpc', id, method, params }))
    })
    ws.addEventListener('message', (event: MessageEvent) => {
      let msg: { type?: string; id?: string; ok?: boolean; value?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.type !== 'rpc:result' || msg.id !== id) return
      clearTimeout(timer)
      ws.close()
      settled = true
      if (msg.ok) resolve(msg.value)
      else reject(new Error(msg.error?.message || 'request failed'))
    })
    ws.addEventListener('error', () => {
      fail(new Error('websocket error'))
    })
    ws.addEventListener('close', () => {
      fail(new Error('websocket closed before response'))
    })
  })
}
