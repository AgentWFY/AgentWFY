import type { BaseWindow, Rectangle, View, WebContentsView } from 'electron';
import type { TabData, TabViewState } from './desktop-page-types.js';

export const FALLBACK_VIEW_WIDTH = 1280;
export const FALLBACK_VIEW_HEIGHT = 720;
export const ZERO_BOUNDS: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

// Far-negative origin for capturePage's forced paint. Any realistic desktop
// window fits inside a 30k pixel half-plane around the origin, so painting
// at this coordinate is guaranteed off-screen.
export const CAPTURE_OFFSCREEN_OFFSET = -30000;

interface DesktopPageLayoutDeps {
  getMainWindow: () => BaseWindow | null;
  getOverlayViews?: () => ReadonlyArray<WebContentsView>;
  getSelectedTabId: () => string | null;
  getTabById: (tabId: string) => TabData | undefined;
  getTabViewState: (tabId: string) => TabViewState | undefined;
  listTabViewStates: () => Iterable<TabViewState>;
}

export class DesktopPageLayout {
  private readonly deps: DesktopPageLayoutDeps;
  private selectedBounds: Rectangle | null = null;
  // True while setAllTabsCollapsed has forced every view to 0x0 (zen mode,
  // app hidden). Placement paths must be no-ops while this is set, or a
  // keyboard shortcut or agent switch would re-expand the selected page.
  private collapsed = false;
  // True only for the agent currently shown in the window. All
  // WebContentsViews share mainWindow.contentView.children, so inactive
  // managers keep client pages at 0x0 bounds.
  private isActive = false;

  constructor(deps: DesktopPageLayoutDeps) {
    this.deps = deps;
  }

  describeState(): {
    selectedTabId: string | null;
    selectedBounds: Rectangle | null;
    totalChildren: number;
    tabs: Array<{
      tabId: string;
      viewName: string;
      bounds: Rectangle;
      zIndex: number;
      visible: boolean;
      isSelected: boolean;
    }>;
  } {
    const mainWindow = this.deps.getMainWindow();
    const children = mainWindow && !mainWindow.isDestroyed() ? mainWindow.contentView.children : [];
    const selectedTabId = this.deps.getSelectedTabId();
    const tabs = Array.from(this.deps.listTabViewStates()).map((state) => ({
      tabId: state.tabId,
      viewName: state.viewName,
      bounds: state.view.getBounds(),
      zIndex: children.indexOf(state.view),
      visible: state.view.getVisible(),
      isSelected: state.tabId === selectedTabId,
    }));
    return {
      selectedTabId,
      selectedBounds: this.selectedBounds,
      totalChildren: children.length,
      tabs,
    };
  }

  getSelectedBounds(): Rectangle | null {
    return this.selectedBounds;
  }

  defaultContentBounds(): Rectangle {
    const mainWindow = this.deps.getMainWindow();
    const [w, h] = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getContentSize()
      : [FALLBACK_VIEW_WIDTH, FALLBACK_VIEW_HEIGHT];
    return { x: 0, y: 0, width: w, height: h };
  }

  headlessBounds(tab: TabData): Rectangle {
    const viewport = tab.viewport ?? { width: FALLBACK_VIEW_WIDTH, height: FALLBACK_VIEW_HEIGHT };
    return {
      x: CAPTURE_OFFSCREEN_OFFSET,
      y: CAPTURE_OFFSCREEN_OFFSET,
      width: viewport.width,
      height: viewport.height,
    };
  }

  applyTabViewPlacement(state: TabViewState, bounds: Rectangle, visible: boolean): void {
    this.attachTabViewToWindow(state);

    const tab = this.deps.getTabById(state.tabId);
    if (tab?.headless) {
      state.view.setBounds(this.headlessBounds(tab));
      state.view.setVisible(true);
      return;
    }

    if (!this.isActive) {
      state.view.setBounds(ZERO_BOUNDS);
      return;
    }

    if (visible) {
      if (this.collapsed) {
        return;
      }
      const changed =
        !this.selectedBounds ||
        this.selectedBounds.x !== bounds.x ||
        this.selectedBounds.y !== bounds.y ||
        this.selectedBounds.width !== bounds.width ||
        this.selectedBounds.height !== bounds.height;
      if (changed) {
        this.selectedBounds = bounds;
        for (const other of this.deps.listTabViewStates()) {
          if (other !== state) other.view.setBounds(bounds);
        }
      }
      this.bringToFront(state);
    } else {
      state.view.setBounds(bounds);
      state.view.setVisible(true);

      if (state.tabId === this.deps.getSelectedTabId()) {
        for (const other of this.deps.listTabViewStates()) {
          if (other !== state) {
            other.view.setBounds(ZERO_BOUNDS);
          }
        }
      } else {
        const selectedId = this.deps.getSelectedTabId();
        const selected = selectedId ? this.deps.getTabViewState(selectedId) : undefined;
        if (selected) {
          this.bringToFront(selected);
        }
      }
    }
  }

  promoteSelectedToFront(): void {
    const selectedTabId = this.deps.getSelectedTabId();
    if (!selectedTabId) return;
    const state = this.deps.getTabViewState(selectedTabId);
    if (!state) return;
    this.applyTabViewPlacement(state, this.selectedBounds ?? this.defaultContentBounds(), true);
  }

  activateViews(): void {
    this.isActive = true;
    this.promoteSelectedToFront();
  }

  deactivateViews(): void {
    this.isActive = false;
    this.zeroAllViewBounds();
  }

  setAllTabsCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    if (collapsed) {
      this.zeroAllViewBounds();
    } else if (this.isActive && this.selectedBounds) {
      for (const state of this.deps.listTabViewStates()) {
        const tab = this.deps.getTabById(state.tabId);
        if (tab?.headless) {
          state.view.setBounds(this.headlessBounds(tab));
        } else {
          state.view.setBounds(this.selectedBounds);
        }
      }
      this.promoteSelectedToFront();
    }
  }

  zeroAllViewBounds(): void {
    for (const state of this.deps.listTabViewStates()) {
      const tab = this.deps.getTabById(state.tabId);
      state.view.setBounds(tab?.headless ? this.headlessBounds(tab) : ZERO_BOUNDS);
    }
  }

  private attachTabViewToWindow(state: TabViewState): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    if (mainWindow.contentView.children.includes(state.view)) {
      return;
    }

    try {
      mainWindow.contentView.addChildView(state.view);
    } catch {
      // defensive: Electron may still consider it a child
    }
  }

  private bringToFront(state: TabViewState): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    if (this.collapsed || !this.isActive) {
      return;
    }

    state.view.setBounds(this.selectedBounds ?? this.defaultContentBounds());
    state.view.setVisible(true);

    const children = mainWindow.contentView.children;
    const currentIndex = children.indexOf(state.view);
    if (currentIndex < 0) return;

    const overlayViews = this.deps.getOverlayViews?.() ?? [];
    const overlaySet = new Set<View>(overlayViews);
    const aboveTab = children.slice(currentIndex + 1);
    if (aboveTab.every(c => overlaySet.has(c))) return;

    const overlaysOrdered = children.filter(c => overlaySet.has(c));
    try {
      mainWindow.contentView.removeChildView(state.view);
      mainWindow.contentView.addChildView(state.view);
      for (const overlay of overlaysOrdered) {
        mainWindow.contentView.removeChildView(overlay);
        mainWindow.contentView.addChildView(overlay);
      }
    } catch {
      // defensive: a view may have been detached concurrently
    }
  }
}
