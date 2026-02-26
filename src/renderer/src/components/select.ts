const CHEVRON_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06z"/></svg>`

const STYLES = `
  :host {
    display: block;
    position: relative;
    width: 100%;
  }
  :host([disabled]) {
    opacity: 0.45;
    pointer-events: none;
  }
  .trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
    box-sizing: border-box;
    font-family: var(--font-family);
    font-size: 13px;
    color: var(--color-text4);
    background: var(--color-input-bg);
    border: 1px solid var(--color-input-border);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
    cursor: pointer;
    user-select: none;
    transition: border-color 120ms ease;
    text-align: left;
  }
  .trigger:hover {
    border-color: var(--color-text2);
  }
  :host(.open) .trigger {
    border-color: var(--color-focus-border);
  }
  .trigger-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .trigger-label.placeholder {
    color: var(--color-placeholder);
  }
  .trigger-chevron {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    color: var(--color-text2);
    transition: transform 120ms ease;
  }
  :host(.open) .trigger-chevron {
    transform: rotate(180deg);
  }
  .dropdown {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 2px;
    background: var(--color-input-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 9000;
    max-height: 200px;
    overflow-y: auto;
    padding: 3px 0;
  }
  :host(.open) .dropdown {
    display: block;
  }
  .option {
    display: flex;
    align-items: center;
    padding: 5px 8px;
    font-size: 13px;
    color: var(--color-text3);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .option:hover,
  .option.focused {
    background: var(--color-item-hover);
    color: var(--color-text4);
  }
  .option.selected {
    color: var(--color-accent);
    font-weight: 600;
  }
`

interface SelectOption {
  value: string
  label: string
}

export class TlSelect extends HTMLElement {
  private shadow: ShadowRoot
  private triggerEl!: HTMLButtonElement
  private labelEl!: HTMLSpanElement
  private dropdownEl!: HTMLDivElement
  private options: SelectOption[] = []
  private _value = ''
  private focusedIndex = -1
  private isOpen = false

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
  }

  static get observedAttributes() {
    return ['value', 'disabled']
  }

  get value(): string { return this._value }
  set value(val: string) {
    this._value = val
    this.updateLabel()
  }

  get disabled(): boolean { return this.hasAttribute('disabled') }
  set disabled(val: boolean) {
    if (val) {
      this.setAttribute('disabled', '')
    } else {
      this.removeAttribute('disabled')
    }
  }

  connectedCallback() {
    this.buildShadow()
    this.readOptions()
    this.updateLabel()

    this.observer = new MutationObserver(() => {
      this.readOptions()
      this.updateLabel()
    })
    this.observer.observe(this, { childList: true, subtree: true, characterData: true })
  }

  private observer: MutationObserver | null = null

  disconnectedCallback() {
    this.observer?.disconnect()
    this.observer = null
    document.removeEventListener('mousedown', this.onDocMousedown)
    document.removeEventListener('keydown', this.onDocKeydown)
  }

  attributeChangedCallback(name: string, _old: string | null, val: string | null) {
    if (name === 'value') {
      this._value = val ?? ''
      this.updateLabel()
    }
  }

  private buildShadow() {
    const style = document.createElement('style')
    style.textContent = STYLES

    this.triggerEl = document.createElement('button')
    this.triggerEl.type = 'button'
    this.triggerEl.className = 'trigger'
    this.triggerEl.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.toggle()
    })

    this.labelEl = document.createElement('span')
    this.labelEl.className = 'trigger-label'

    const chevron = document.createElement('span')
    chevron.className = 'trigger-chevron'
    chevron.innerHTML = CHEVRON_SVG

    this.triggerEl.appendChild(this.labelEl)
    this.triggerEl.appendChild(chevron)

    this.dropdownEl = document.createElement('div')
    this.dropdownEl.className = 'dropdown'

    this.shadow.appendChild(style)
    this.shadow.appendChild(this.triggerEl)
    this.shadow.appendChild(this.dropdownEl)
  }

  private readOptions() {
    this.options = []
    const children = this.querySelectorAll('option')
    children.forEach(opt => {
      this.options.push({
        value: opt.value,
        label: opt.textContent?.trim() || opt.value,
      })
    })

    // If no value set yet, pick from selected attribute or first
    if (!this._value && this.options.length > 0) {
      const selected = this.querySelector('option[selected]') as HTMLOptionElement | null
      this._value = selected ? selected.value : this.options[0].value
    }
  }

  private updateLabel() {
    if (!this.labelEl) return
    const opt = this.options.find(o => o.value === this._value)
    if (opt) {
      this.labelEl.textContent = opt.label
      this.labelEl.classList.remove('placeholder')
    } else {
      this.labelEl.textContent = 'Select...'
      this.labelEl.classList.add('placeholder')
    }
  }

  private toggle() {
    if (this.isOpen) {
      this.close()
    } else {
      this.open()
    }
  }

  private open() {
    if (this.isOpen || this.disabled) return
    this.isOpen = true
    this.classList.add('open')
    this.focusedIndex = this.options.findIndex(o => o.value === this._value)
    this.renderDropdown()
    document.addEventListener('mousedown', this.onDocMousedown)
    document.addEventListener('keydown', this.onDocKeydown)
  }

  private close() {
    if (!this.isOpen) return
    this.isOpen = false
    this.classList.remove('open')
    this.focusedIndex = -1
    document.removeEventListener('mousedown', this.onDocMousedown)
    document.removeEventListener('keydown', this.onDocKeydown)
  }

  private select(value: string) {
    if (value === this._value) {
      this.close()
      return
    }
    this._value = value
    this.updateLabel()
    this.close()

    this.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  }

  private renderDropdown() {
    this.dropdownEl.innerHTML = ''
    this.options.forEach((opt, idx) => {
      const el = document.createElement('div')
      el.className = 'option'
      if (opt.value === this._value) el.classList.add('selected')
      if (idx === this.focusedIndex) el.classList.add('focused')
      el.textContent = opt.label
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.select(opt.value)
      })
      el.addEventListener('mouseenter', () => {
        this.focusedIndex = idx
        this.updateFocused()
      })
      this.dropdownEl.appendChild(el)
    })
  }

  private updateFocused() {
    const items = this.dropdownEl.querySelectorAll('.option')
    items.forEach((el, i) => {
      el.classList.toggle('focused', i === this.focusedIndex)
    })
  }

  private scrollFocusedIntoView() {
    const items = this.dropdownEl.querySelectorAll('.option')
    const el = items[this.focusedIndex]
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }

  private onDocMousedown = (e: MouseEvent) => {
    if (!this.contains(e.target as Node) && !this.shadow.contains(e.target as Node)) {
      this.close()
    }
  }

  private onDocKeydown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        this.close()
        break
      case 'ArrowDown':
        e.preventDefault()
        this.focusedIndex = Math.min(this.focusedIndex + 1, this.options.length - 1)
        this.updateFocused()
        this.scrollFocusedIntoView()
        break
      case 'ArrowUp':
        e.preventDefault()
        this.focusedIndex = Math.max(this.focusedIndex - 1, 0)
        this.updateFocused()
        this.scrollFocusedIntoView()
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (this.focusedIndex >= 0 && this.focusedIndex < this.options.length) {
          this.select(this.options[this.focusedIndex].value)
        }
        break
    }
  }
}
