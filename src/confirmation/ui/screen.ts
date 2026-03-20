export interface ConfirmationScreen {
  title: string
  renderBody(container: HTMLElement): void
  confirmLabel: string
  cancelLabel?: string
}

export type ConfirmationScreenFactory = (params: Record<string, unknown>) => ConfirmationScreen
