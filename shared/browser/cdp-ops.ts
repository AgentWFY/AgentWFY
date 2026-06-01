import type { PageConsoleLog } from '../page/types.js'
import {
  buildPageExecutionCode,
  readCdpRemoteObjectValue,
  resolvePageJsTimeout,
  withPageJsTimeout,
} from '../page/page-js.js'
import { PAGE_MOUSE_EVENT_TYPES, normalizePageInput, type PageInputLike, type PageInputModifier } from '../page/page-input.js'

const CAPTURE_RETRY_BUDGET_MS = 3000

export interface CdpPageHandle {
  sendCdp(method: string, params?: unknown, sessionId?: string): Promise<unknown>
  getConsoleLogs?(request?: { since?: number; limit?: number }): Promise<PageConsoleLog[]>
}

export interface CdpCaptureResult {
  base64: string
  mimeType: 'image/png'
}

export async function capture(handle: CdpPageHandle): Promise<CdpCaptureResult> {
  // The page can still be settling right after openPage/openTab — Chrome answers
  // Page.captureScreenshot with "Not attached to an active page". Retry on a
  // short budget so an immediate capture doesn't race the navigation.
  const deadline = Date.now() + CAPTURE_RETRY_BUDGET_MS
  while (true) {
    try {
      const result = await handle.sendCdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      }) as { data?: unknown }

      if (typeof result.data !== 'string') {
        throw new Error('Page.captureScreenshot did not return image data')
      }

      return { base64: result.data, mimeType: 'image/png' }
    } catch (err) {
      if (!isNotAttachedError(err) || Date.now() >= deadline) throw err
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
  }
}

export function isNotAttachedError(err: unknown): boolean {
  return String(err instanceof Error ? err.message : err).includes('Not attached to an active page')
}

export async function execJs(
  handle: CdpPageHandle,
  code: string,
  timeoutMs?: number,
): Promise<unknown> {
  if (typeof code !== 'string') {
    throw new Error('runPageJs requires code as a string')
  }

  const { timeoutMs: effectiveTimeout, wasDefault } = resolvePageJsTimeout(timeoutMs)
  const expression = buildPageExecutionCode(code)

  const result = await withPageJsTimeout(
    handle.sendCdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }),
    effectiveTimeout,
    wasDefault,
  )

  return readCdpRemoteObjectValue(result)
}

export async function dispatchInput(handle: CdpPageHandle, request: PageInputLike): Promise<void> {
  const input = normalizePageInput(request)
  const modifiers = cdpModifierMask(input.modifiers)

  if (input.type === 'click') {
    const button = cdpMouseButton(input.button)
    await handle.sendCdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: input.x,
      y: input.y,
      button,
      clickCount: input.clickCount,
      modifiers,
    })
    await handle.sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: input.x,
      y: input.y,
      button,
      clickCount: input.clickCount,
      modifiers,
    })
    return
  }

  if (input.type === 'mouseWheel') {
    await handle.sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: input.x,
      y: input.y,
      deltaX: input.deltaX,
      deltaY: input.deltaY,
      modifiers,
    })
    return
  }

  if (PAGE_MOUSE_EVENT_TYPES.has(input.type)) {
    await handle.sendCdp('Input.dispatchMouseEvent', {
      type: cdpMouseEventType(input.type),
      x: input.x,
      y: input.y,
      button: cdpMouseButton(input.button),
      clickCount: input.type === 'mouseDown'
        ? input.clickCount
        : undefined,
      modifiers,
    })
    return
  }

  if (input.type === 'keyDown' || input.type === 'keyUp' || input.type === 'char') {
    await handle.sendCdp('Input.dispatchKeyEvent', {
      type: cdpKeyEventType(input.type),
      key: input.keyCode,
      code: input.keyCode,
      text: input.type === 'char' ? input.keyCode : undefined,
      modifiers,
    })
    return
  }
}

function cdpMouseButton(button: string | undefined): 'left' | 'middle' | 'right' | 'none' {
  if (button === 'left' || button === 'middle' || button === 'right') return button
  return 'left'
}

function cdpMouseEventType(type: string): 'mousePressed' | 'mouseReleased' | 'mouseMoved' {
  switch (type) {
    case 'mouseDown':
      return 'mousePressed'
    case 'mouseUp':
      return 'mouseReleased'
    default:
      return 'mouseMoved'
  }
}

function cdpKeyEventType(type: string): 'keyDown' | 'keyUp' | 'char' {
  if (type === 'keyUp') return 'keyUp'
  if (type === 'char') return 'char'
  return 'keyDown'
}

function cdpModifierMask(modifiers: readonly PageInputModifier[]): number {
  let mask = 0
  for (const modifier of modifiers ?? []) {
    if (modifier === 'alt') mask |= 1
    if (modifier === 'control') mask |= 2
    if (modifier === 'meta') mask |= 4
    if (modifier === 'shift') mask |= 8
  }
  return mask
}

export async function inspect(handle: CdpPageHandle, selector: string): Promise<unknown> {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error('inspectElement requires a non-empty CSS selector')
  }

  const selectorLiteral = JSON.stringify(selector)
  const code = `
  const el = document.querySelector(${selectorLiteral});
  if (!el) return { found: false };

  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  return {
    found: true,
    tagName: el.tagName.toLowerCase(),
    textContent: (el.textContent || '').trim().slice(0, 500),
    attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
    classes: Array.from(el.classList),
    box: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    },
    styles: {
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      position: cs.position,
      overflow: cs.overflow,
      zIndex: cs.zIndex,
      boxSizing: cs.boxSizing,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      textAlign: cs.textAlign,
      border: cs.border,
      borderCollapse: cs.borderCollapse,
      padding: cs.padding,
      margin: cs.margin,
      width: cs.width,
      height: cs.height,
      minWidth: cs.minWidth,
      maxWidth: cs.maxWidth,
      minHeight: cs.minHeight,
      maxHeight: cs.maxHeight,
      cursor: cs.cursor,
      pointerEvents: cs.pointerEvents,
      userSelect: cs.userSelect,
      whiteSpace: cs.whiteSpace,
      textOverflow: cs.textOverflow,
      flexGrow: cs.flexGrow,
      flexShrink: cs.flexShrink,
      gridTemplateColumns: cs.gridTemplateColumns,
    },
    isVisible: cs.display !== 'none'
      && cs.visibility !== 'hidden'
      && parseFloat(cs.opacity) > 0
      && rect.width > 0
      && rect.height > 0,
    isInViewport: rect.top < window.innerHeight
      && rect.bottom > 0
      && rect.left < window.innerWidth
      && rect.right > 0,
    childCount: el.children.length,
    parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
  };`

  return execJs(handle, code)
}

export async function getConsoleLogs(
  handle: CdpPageHandle,
  request?: { since?: number; limit?: number },
): Promise<PageConsoleLog[]> {
  if (handle.getConsoleLogs) {
    return handle.getConsoleLogs(request)
  }
  return []
}
