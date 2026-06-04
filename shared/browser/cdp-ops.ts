import type { PageConsoleLog } from '../page/types.js'
import {
  buildPageExecutionCode,
  readCdpRemoteObjectValue,
  resolvePageJsTimeout,
  withPageJsTimeout,
} from '../page/page-js.js'
import { buildInspectElementCode } from '../page/element-inspection.js'
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
  // The page can still be settling right after openPage — Chrome answers
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
  return execJs(handle, buildInspectElementCode(selector))
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
