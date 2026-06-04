import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { Channels } from './channels.cjs';
import { getViewByName } from '#shared/db/views.js';
import type {
  OpenPageRequest,
  PageApi,
} from '#shared/page/types.js';
import { normalizePageSource } from '#shared/page/page-source.js';

function parsePageId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  const input = value && typeof value === 'object'
    ? value as { pageId?: unknown; id?: unknown }
    : {};
  const pageId = input.pageId ?? input.id;
  if (typeof pageId === 'string' && pageId.trim().length > 0) {
    return pageId.trim();
  }

  throw new Error('pageId must be a non-empty string');
}

function normalizeHeadlessFilter(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error('headless must be a boolean');
}

async function normalizeOpenPagePayload(
  payload: unknown,
  cacheRoot: string,
): Promise<OpenPageRequest> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('openClientPage requires a request object');
  }

  const input = payload as Record<string, unknown>;
  const source = normalizePageSource(input.source);
  let resolvedSource = source;
  let resolvedTitle = typeof input.title === 'string' ? input.title : undefined;

  if (source.type === 'view') {
    const view = await getViewByName(cacheRoot, source.name);
    if (!view) {
      throw new Error(`View not found: ${source.name}`);
    }
    resolvedSource = { ...source, name: view.name };
    resolvedTitle = resolvedTitle ?? (view.title || view.name);
  }

  return {
    source: resolvedSource,
    title: resolvedTitle,
    ...(input.viewport !== undefined ? { viewport: input.viewport as OpenPageRequest['viewport'] } : {}),
    ...(typeof input.width === 'number' ? { width: input.width } : {}),
    ...(typeof input.height === 'number' ? { height: input.height } : {}),
    ...(input.closeAfterIdleMs !== undefined ? { closeAfterIdleMs: input.closeAfterIdleMs as OpenPageRequest['closeAfterIdleMs'] } : {}),
  };
}

export function registerPageHandlers(
  getPageTools: (e: IpcMainInvokeEvent) => PageApi,
  getCacheRoot: (e: IpcMainInvokeEvent) => string,
  getHeadlessPageCount?: () => Promise<number> | number,
): void {
  ipcMain.handle(Channels.pages.getPages, async (event, payload: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as { headless?: unknown } : {};
    return getPageTools(event).getPages({
      headless: normalizeHeadlessFilter(input.headless),
    });
  });

  ipcMain.handle(Channels.pages.openClientPage, async (event, payload: unknown) => {
    const request = await normalizeOpenPagePayload(payload, getCacheRoot(event));
    return getPageTools(event).openClientPage(request);
  });

  ipcMain.handle(Channels.pages.closePage, async (event, payload: unknown) => {
    await getPageTools(event).closePage({ pageId: parsePageId(payload) });
  });

  ipcMain.handle(Channels.pages.reloadPage, async (event, payload: unknown) => {
    return getPageTools(event).reloadPage({ pageId: parsePageId(payload) });
  });

  ipcMain.handle(Channels.pages.getHeadlessCount, async () => {
    return getHeadlessPageCount ? getHeadlessPageCount() : 0;
  });
}
