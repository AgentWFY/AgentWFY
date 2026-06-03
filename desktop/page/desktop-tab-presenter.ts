import type { TabData, TabState } from './desktop-page-types.js';

interface CloseTabResult {
  closed: boolean
  wasSelected: boolean
  tab?: TabData
}

interface DesktopTabPresenterDeps {
  onStateChanged: (state: TabState) => void;
}

export class DesktopTabPresenter {
  private readonly deps: DesktopTabPresenterDeps;
  private tabs: TabData[] = [];
  private selectedTabId: string | null = null;

  constructor(deps: DesktopTabPresenterDeps) {
    this.deps = deps;
  }

  getSelectedTabId(): string | null {
    return this.selectedTabId;
  }

  getState(): TabState {
    return { tabs: this.listTabsForRuntime(), selectedTabId: this.selectedTabId };
  }

  getTabData(tabId: string): TabData | null {
    return this.listTabsForRuntime().find(tab => tab.id === tabId) ?? null;
  }

  tabById(tabId: string): TabData | undefined {
    return this.tabs.find(tab => tab.id === tabId);
  }

  pushState(): void {
    this.deps.onStateChanged(this.getState());
  }

  clear(): void {
    this.tabs = [];
    this.selectedTabId = null;
  }

  addTab(tab: TabData, options: { select: boolean; push?: boolean }): void {
    this.tabs = [...this.tabs, tab];
    if (options.select) {
      this.selectedTabId = tab.id;
    }
    if (options.push) {
      this.pushState();
    }
  }

  listTabsForRuntime(): TabData[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      tabId: tab.id,
      title: tab.title || '',
      type: tab.type || 'view',
      target: tab.target ?? null,
      headless: Boolean(tab.headless),
      viewport: tab.headless ? tab.viewport : null,
      viewUpdatedAt: tab.viewUpdatedAt ?? null,
      viewChanged: Boolean(tab.viewChanged),
      pinned: Boolean(tab.pinned),
      selected: tab.id === this.selectedTabId,
      params: tab.params || null,
      openedAt: tab.openedAt,
      lastUsedAt: tab.lastUsedAt,
      closeAfterIdleMs: tab.closeAfterIdleMs ?? null,
      expiresAt: tab.expiresAt ?? null,
    }));
  }

  currentTabForRuntime(): TabData | null {
    if (!this.selectedTabId) return null;
    const tabs = this.listTabsForRuntime();
    return tabs.find(tab => tab.id === this.selectedTabId && !tab.headless) ?? null;
  }

  closeTab(tabId: string): CloseTabResult {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || tab.pinned) return { closed: false, wasSelected: false };

    const wasSelected = this.selectedTabId === tabId;
    this.tabs = this.tabs.filter(t => t.id !== tabId);
    if (wasSelected) {
      const visible = this.tabs.filter(t => !t.headless);
      const last = visible[visible.length - 1];
      this.selectedTabId = last?.id || null;
    }
    return { closed: true, wasSelected, tab };
  }

  selectTab(tabId: string): boolean {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return false;
    if (this.selectedTabId === tabId) return false;
    this.selectedTabId = tabId;
    return true;
  }

  markTabFresh(tabId: string, options: { viewUpdatedAt?: number | null } = {}): boolean {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return false;
    if (options.viewUpdatedAt !== undefined) {
      tab.viewUpdatedAt = options.viewUpdatedAt;
    }
    tab.viewChanged = false;
    return true;
  }

  markViewChanged(viewName: string): boolean {
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.type !== 'view' || tab.target !== viewName) continue;
      tab.viewChanged = true;
      changed = true;
    }
    return changed;
  }

  togglePin(tabId: string): void {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    const pinned = this.tabs.filter(t => t.pinned);
    const unpinned = this.tabs.filter(t => !t.pinned);
    this.tabs = [...pinned, ...unpinned];
    this.pushState();
  }

  reorderTabs(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= this.tabs.length) return;
    if (toIndex < 0 || toIndex >= this.tabs.length) return;

    const pinnedEnd = this.tabs.filter(t => t.pinned && !t.headless).length;
    const fromPinned = fromIndex < pinnedEnd;
    const toPinned = toIndex < pinnedEnd;
    if (fromPinned !== toPinned) return;

    const newTabs = [...this.tabs];
    const [tab] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, tab);
    this.tabs = newTabs;
    this.pushState();
  }

  selectVisibleTabByIndex(index: number): boolean {
    const visible = this.tabs.filter(t => !t.headless);
    if (index < 0 || index >= visible.length) return false;
    const tab = visible[index];
    if (tab.id === this.selectedTabId) return false;
    this.selectedTabId = tab.id;
    return true;
  }

  selectNextVisibleTab(): boolean {
    const visible = this.tabs.filter(t => !t.headless);
    if (visible.length <= 1) return false;
    const currentIdx = visible.findIndex(t => t.id === this.selectedTabId);
    const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % visible.length;
    this.selectedTabId = visible[nextIdx].id;
    return true;
  }

  selectPreviousVisibleTab(): boolean {
    const visible = this.tabs.filter(t => !t.headless);
    if (visible.length <= 1) return false;
    const currentIdx = visible.findIndex(t => t.id === this.selectedTabId);
    const prevIdx = currentIdx <= 0 ? visible.length - 1 : currentIdx - 1;
    this.selectedTabId = visible[prevIdx].id;
    return true;
  }
}
