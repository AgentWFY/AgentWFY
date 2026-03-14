import { createListScreen } from './list-screen.js'

export const RecentAgentsScreen = createListScreen({
  id: 'recent-agents',
  breadcrumb: 'Recent Agents',
  placeholder: 'Search recent agents...',
  emptyText: 'No recent agents',
  enterLabel: 'switch',
  listFn: (bridge) => bridge.listRecentAgents(),
})
