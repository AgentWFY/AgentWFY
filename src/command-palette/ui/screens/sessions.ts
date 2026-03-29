import { createListScreen } from './list-screen.js'

export const SessionsScreen = createListScreen({
  id: 'sessions',
  breadcrumb: 'Sessions',
  placeholder: 'Filter sessions\u2026',
  emptyText: 'No sessions',
  enterLabel: 'open',
  listFn: (bridge) => bridge.listSessions(),
})
