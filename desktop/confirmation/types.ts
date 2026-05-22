export interface ConfirmationResult {
  confirmed: boolean
  data?: Record<string, unknown>
}

export const CONFIRMATION_CHANNEL = {
  SHOW: 'app:confirmation:show',
  RESULT: 'app:confirmation:result',
  PICK_DIRECTORY: 'app:confirmation:pickDirectory',
} as const
