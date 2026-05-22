import { createListScreen } from './list-screen.js'

export const AgentsScreen = createListScreen({
  id: 'agents',
  breadcrumb: 'Agents',
  placeholder: 'Filter agents…',
  emptyText: 'No agents',
  enterLabel: 'switch',
  listFn: (bridge) => bridge.listAgents(),
})
