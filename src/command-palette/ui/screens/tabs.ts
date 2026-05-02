import { createListScreen } from './list-screen.js'

export const TabsScreen = createListScreen({
  id: 'tabs',
  breadcrumb: 'Tabs',
  placeholder: 'Filter tabs…',
  emptyText: 'No open tabs',
  enterLabel: 'switch',
  listFn: (bridge) => bridge.listTabs(),
})
