import { ipcMain } from 'electron';
import type { PreviewCursorManager } from '../preview-cursor/manager.js';
import { Channels } from './channels.cjs';

interface PreviewCursorHandlerDeps {
  getPreviewCursor: () => PreviewCursorManager | null;
}

export function registerPreviewCursorHandlers(deps: PreviewCursorHandlerDeps): void {
  ipcMain.handle(Channels.previewCursor.setPos, (_event, payload: { x: number; y: number }) => {
    deps.getPreviewCursor()?.setPos(payload.x, payload.y);
  });

  ipcMain.handle(Channels.previewCursor.setVisible, (_event, visible: boolean) => {
    deps.getPreviewCursor()?.setVisible(!!visible);
  });

  ipcMain.handle(Channels.previewCursor.flash, () => {
    deps.getPreviewCursor()?.flash();
  });
}
