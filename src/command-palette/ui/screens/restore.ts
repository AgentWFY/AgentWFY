import { createListScreen } from './list-screen.js'

export const RestoreScreen = createListScreen({
  id: 'restore',
  breadcrumb: 'Restore Agent Database',
  placeholder: 'Select backup to restore\u2026',
  emptyText: 'No backups found',
  enterLabel: 'restore',
  listFn: (bridge) => bridge.listBackups(),
})
