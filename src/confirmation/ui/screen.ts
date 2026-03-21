export interface ConfirmationScreen {
  title: string
  renderBody(container: HTMLElement): void
  confirmLabel: string
  cancelLabel?: string
  /** Return data to include in the result when confirmed. Return null to block confirmation (e.g. required field not filled). */
  getData?: () => Record<string, unknown> | null
}

export type ConfirmationScreenFactory = (params: Record<string, unknown>) => ConfirmationScreen
