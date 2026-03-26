import { createListScreen } from './list-screen.js'

export const SessionsScreen = createListScreen({
  id: 'sessions',
  breadcrumb: 'Sessions',
  placeholder: 'Search sessions...',
  emptyText: 'No sessions',
  enterLabel: 'open',
  listFn: (bridge) => bridge.listSessions(),
})
