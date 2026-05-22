/** Create a Save/Cancel (or Run/Cancel) action button bar. */
export function createActionButtons(primaryLabel = 'Save'): HTMLDivElement {
  const actions = document.createElement('div')
  actions.className = 'actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'btn'
  cancelBtn.type = 'button'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.dataset.action = 'cancel'
  actions.appendChild(cancelBtn)

  const primaryBtn = document.createElement('button')
  primaryBtn.className = 'btn primary'
  primaryBtn.type = 'button'
  primaryBtn.textContent = primaryLabel
  primaryBtn.dataset.action = 'save'
  actions.appendChild(primaryBtn)

  return actions
}
