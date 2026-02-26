export class TlJson extends HTMLElement {
  private _json: any = {}
  private _isOpen = false
  private _placeholder = '{..}'
  private preEl: HTMLPreElement

  constructor() {
    super()
    this.preEl = document.createElement('pre')
    this.preEl.style.cssText = 'cursor:pointer;margin:0;color:var(--spectrum-global-color-gray-500);font-size:12px;'
    this.preEl.addEventListener('click', () => {
      this._isOpen = !this._isOpen
      this.updateDisplay()
    })
  }

  connectedCallback() {
    this.appendChild(this.preEl)
    this.updateDisplay()
  }

  set json(value: any) {
    this._json = value
    this.updateDisplay()
  }

  get json() { return this._json }

  set isOpen(value: boolean) {
    this._isOpen = value
    this.updateDisplay()
  }

  get isOpen() { return this._isOpen }

  set placeholder(value: string) {
    this._placeholder = value
    this.updateDisplay()
  }

  get placeholder() { return this._placeholder }

  private updateDisplay() {
    if (this._isOpen) {
      this.preEl.textContent = JSON.stringify(this._json, null, 2)
      this.preEl.style.overflowX = 'scroll'
    } else {
      this.preEl.textContent = this._placeholder
      this.preEl.style.overflowX = ''
    }
  }
}
