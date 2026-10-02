import type { BaseWindow, WebContents } from 'electron';

interface FocusManagerDeps {
  getMainWindow: () => BaseWindow | null;
  getRendererWebContents: () => WebContents | null;
  /** The active agent's selected page, while it is actually on screen. */
  getOnScreenPage: () => WebContents | null;
  /** True while the command palette or a confirmation dialog is up and holds
   *  the keyboard — the user is answering it, and nothing here takes it away. */
  overlayHasKeyboard: () => boolean;
}

/**
 * Decides whether the keyboard belongs to the on-screen page or to the app's
 * own UI (the renderer), and puts it there whenever something moves under it:
 * a tab or agent switch, an overlay closing, the window coming back.
 *
 * Every page and the renderer are separate WebContents, so only one of them
 * receives keys, and nothing hands focus back on its own — without this, the
 * keyboard stays wherever it last landed, often on a page that is no longer
 * shown, or on app chrome the user merely clicked.
 */
export class FocusManager {
  private readonly deps: FocusManagerDeps;
  // Follows the user: clicking into a page gives the page the keyboard,
  // clicking into the app's UI takes it back.
  private pageOwnsKeyboard = false;
  // With the sidebar closed the app's UI has nothing to type into, so the
  // page owns the keyboard whatever was clicked last. Starts open to match
  // the renderer, which reports every change.
  private sidebarOpen = true;

  constructor(deps: FocusManagerDeps) {
    this.deps = deps;
  }

  setSidebarOpen(open: boolean): void {
    if (this.sidebarOpen === open) return;
    this.sidebarOpen = open;
    if (!open) this.sync();
  }

  /** The user pointed at the page (clicked its tab, picked it in the palette). */
  focusPage(): void {
    // With no page on screen the keyboard stays with the app's UI, and so must
    // the intent — otherwise the next page the agent opens would pull the
    // keyboard out of whatever the user is typing in.
    if (!this.deps.getOnScreenPage()) return;
    this.pageOwnsKeyboard = true;
    this.sync();
  }

  /** The app's UI wants to type (the chat input was opened). */
  focusApp(): void {
    this.pageOwnsKeyboard = false;
    this.sync();
  }

  notePageFocused(contents: WebContents): void {
    // A page that is not on screen taking focus is Chromium's doing (a view
    // being attached), not the user's.
    if (contents === this.deps.getOnScreenPage()) this.pageOwnsKeyboard = true;
  }

  noteAppFocused(): void {
    this.pageOwnsKeyboard = false;
    // A click on the tab bar, the agent list, or the status line focuses the
    // renderer. With the sidebar closed there is nothing there to type into —
    // hand the keyboard back once the click has been delivered.
    if (!this.sidebarOpen) setTimeout(() => this.sync(), 0);
  }

  /** Put the keyboard where it belongs now. Never raises the window: focusing
   *  a WebContents of a background window pulls it in front of other apps, so
   *  this waits for the window's own 'focus' event instead. */
  sync(): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed() || !win.isFocused()) return;
    if (this.deps.overlayHasKeyboard()) return;

    const page = this.deps.getOnScreenPage();
    const target = page && (this.pageOwnsKeyboard || !this.sidebarOpen)
      ? page
      : this.deps.getRendererWebContents();
    if (target && !target.isDestroyed() && !target.isFocused()) {
      target.focus();
    }
  }
}
