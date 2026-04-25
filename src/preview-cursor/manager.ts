import { BaseWindow, WebContentsView } from 'electron';

// Preview-only cursor overlay. Headless wlroots exposes no pointer device,
// so sway never draws a real cursor; a renderer-level DOM overlay is
// occluded by tab WebContentsViews stacked above it. This module owns a
// dedicated transparent WebContentsView that stays on top of every other
// child view so a driven "cursor" stays visible regardless of what tab is
// selected.

// Overall view size. The cursor itself is 16x22; the extra room absorbs the
// drop shadow and lets us animate without clipping.
const VIEW_W = 32;
const VIEW_H = 40;

// Cursor hotspot within the view (aligns the arrow tip with (x,y)).
const HOTSPOT_X = 4;
const HOTSPOT_Y = 4;

// macOS-style black arrow — filled black, thin white rim so it stays legible
// on dark surfaces. Hotspot at (1,1) in the cursor path's local space which
// we align to (HOTSPOT_X, HOTSPOT_Y) in the view. Drop-shadow is a separate
// element so it can bleed outside the cursor path.
const CURSOR_HTML = `<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  body { width: 100vw; height: 100vh; }
  svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
</style></head><body>
<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" xmlns="http://www.w3.org/2000/svg">
  <path d="M ${HOTSPOT_X} ${HOTSPOT_Y}
           L ${HOTSPOT_X} ${HOTSPOT_Y + 20}
           L ${HOTSPOT_X + 5} ${HOTSPOT_Y + 15}
           L ${HOTSPOT_X + 8} ${HOTSPOT_Y + 22}
           L ${HOTSPOT_X + 11} ${HOTSPOT_Y + 21}
           L ${HOTSPOT_X + 8} ${HOTSPOT_Y + 14}
           L ${HOTSPOT_X + 14} ${HOTSPOT_Y + 14} Z"
        fill="black" stroke="white" stroke-width="1.25"
        stroke-linejoin="miter" stroke-linecap="square"
        paint-order="stroke fill"
        style="filter: drop-shadow(0 1px 1.5px rgba(0,0,0,0.45));"/>
</svg>
</body></html>`;

export class PreviewCursorManager {
  private view: WebContentsView | null = null;
  private window: BaseWindow;
  // While visible, re-assert top of z-order every tick. The tab-view
  // manager re-attaches its views (setBounds + addChildView) when the
  // layout changes — e.g. sidebar collapse widens the main area — which
  // pushes the cursor down the child stack. Without this tick the
  // cursor visibly disappears until the next setPos call re-tops it.
  private topTimer: ReturnType<typeof setInterval> | null = null;

  constructor(window: BaseWindow) {
    this.window = window;
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#00000000');
    view.setBounds({ x: -VIEW_W, y: -VIEW_H, width: VIEW_W, height: VIEW_H });
    view.setVisible(false);
    void view.webContents.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(CURSOR_HTML),
    );

    this.window.contentView.addChildView(view);
    this.view = view;
    return view;
  }

  setPos(x: number, y: number): void {
    const view = this.ensureView();
    view.setBounds({
      x: Math.round(x - HOTSPOT_X),
      y: Math.round(y - HOTSPOT_Y),
      width: VIEW_W,
      height: VIEW_H,
    });
    this.bringToFront();
    // Moving the overlay alone is purely visual; CSS :hover and JS
    // hover listeners only fire when a real mouseMove is dispatched
    // into the view.
    this.dispatchMouseMove(x, y);
  }

  private dispatchMouseMove(x: number, y: number): void {
    if (!this.window || this.window.isDestroyed()) return;
    const children = this.window.contentView.children;
    for (const child of children) {
      if (!(child instanceof WebContentsView)) continue;
      if (child === this.view) continue;
      const wc = child.webContents;
      if (wc.isDestroyed()) continue;
      const b = child.getBounds();
      // Inactive tab views are kept setVisible(true) at 0×0 bounds so
      // captureTab keeps working; skip them so mouseMove only reaches
      // the views actually under the cursor.
      if (b.width <= 0 || b.height <= 0) continue;
      if (x < b.x || x >= b.x + b.width || y < b.y || y >= b.y + b.height) continue;
      try {
        wc.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(x - b.x),
          y: Math.round(y - b.y),
        });
      } catch {
        // View destroyed mid-call — fine.
      }
    }
  }

  setVisible(visible: boolean): void {
    const view = this.ensureView();
    view.setVisible(visible);
    if (visible) {
      this.bringToFront();
      this.startTopTimer();
    } else {
      this.stopTopTimer();
    }
  }

  getView(): WebContentsView | null {
    if (!this.view || this.view.webContents.isDestroyed()) return null;
    return this.view;
  }

  private startTopTimer(): void {
    if (this.topTimer) return;
    this.topTimer = setInterval(() => this.bringToFront(), 150);
  }

  private stopTopTimer(): void {
    if (this.topTimer) {
      clearInterval(this.topTimer);
      this.topTimer = null;
    }
  }

  private bringToFront(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    try {
      this.window.contentView.removeChildView(this.view);
      this.window.contentView.addChildView(this.view);
    } catch {
      // View already detached or window destroyed — fine, next ensureView recreates.
    }
  }

  destroy(): void {
    this.stopTopTimer();
    if (this.view && !this.view.webContents.isDestroyed()) {
      try { this.window.contentView.removeChildView(this.view); } catch {}
      try { this.view.webContents.close(); } catch {}
    }
    this.view = null;
  }
}
