import type {
  BrowserPageHandle,
  TabCaptureResult,
  TabConsoleLog,
  TabSendInputRequest,
} from '../runtime/hosts.js'
import { formatTimeoutError, resolveTimeout } from '../runtime/timeout_utils.js'

const EXEC_DEFAULT_TIMEOUT_MS = 5000
const EXEC_MAX_TIMEOUT_MS = 120000

type AsyncFunctionConstructor = new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor

function buildEvaluationExpression(code: string): string {
  let mode: 'expression' | 'body' = 'expression'

  try {
    new AsyncFunction(`return (\n${code}\n);`)
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    mode = 'body'
    new AsyncFunction(code)
  }

  const completion = '.then((__agentwfy_value) => __agentwfy_value === undefined ? null : __agentwfy_value)'
  if (mode === 'expression') {
    return `(async function() {\nreturn (\n${code}\n);\n})()${completion}`
  }

  return `(async function() {\n${code}\n})()${completion}`
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, wasDefault: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(formatTimeoutError('execTabJs', timeoutMs, wasDefault, EXEC_MAX_TIMEOUT_MS)))
    }, timeoutMs)

    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function readRemoteObjectValue(result: unknown): unknown {
  const obj = result as {
    result?: { value?: unknown; unserializableValue?: string; type?: string; description?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }

  if (obj.exceptionDetails) {
    const message = obj.exceptionDetails.exception?.description || obj.exceptionDetails.text || 'Runtime.evaluate failed'
    throw new Error(message)
  }

  const remote = obj.result
  if (!remote) return null
  if ('value' in remote) return remote.value
  if (remote.unserializableValue) {
    switch (remote.unserializableValue) {
      case 'NaN':
        return NaN
      case 'Infinity':
        return Infinity
      case '-Infinity':
        return -Infinity
      case '-0':
        return -0
      default:
        return remote.unserializableValue
    }
  }
  if (remote.type === 'undefined') return null
  return remote.description ?? null
}

const CAPTURE_RETRY_BUDGET_MS = 3000

export async function capture(handle: BrowserPageHandle): Promise<TabCaptureResult> {
  // The page can still be settling right after openTab — Chrome answers
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
  handle: BrowserPageHandle,
  code: string,
  timeoutMs?: number,
): Promise<unknown> {
  if (typeof code !== 'string') {
    throw new Error('execTabJs requires code as a string')
  }

  const { timeoutMs: requestedTimeout, wasDefault } = resolveTimeout(timeoutMs, EXEC_DEFAULT_TIMEOUT_MS)
  const effectiveTimeout = Math.max(1, Math.min(requestedTimeout, EXEC_MAX_TIMEOUT_MS))
  const expression = buildEvaluationExpression(code)

  const result = await withTimeout(
    handle.sendCdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }),
    effectiveTimeout,
    wasDefault,
  )

  return readRemoteObjectValue(result)
}

export async function dispatchInput(handle: BrowserPageHandle, request: TabSendInputRequest): Promise<void> {
  const type = request.type
  const x = Math.round(request.x ?? 0)
  const y = Math.round(request.y ?? 0)
  const modifiers = cdpModifierMask(request.modifiers)

  if (type === 'click') {
    const button = cdpMouseButton(request.button)
    const clickCount = Math.max(1, Math.floor(request.clickCount ?? 1))
    await handle.sendCdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
      modifiers,
    })
    await handle.sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
      modifiers,
    })
    return
  }

  if (type === 'mouseWheel' || type === 'mousewheel') {
    await handle.sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: request.deltaX ?? 0,
      deltaY: request.deltaY ?? 0,
      modifiers,
    })
    return
  }

  if (type === 'mouseDown' || type === 'mousedown' || type === 'mouseUp' || type === 'mouseup' || type === 'mouseMove' || type === 'mousemove') {
    await handle.sendCdp('Input.dispatchMouseEvent', {
      type: cdpMouseEventType(type),
      x,
      y,
      button: cdpMouseButton(request.button),
      clickCount: type === 'mouseDown' || type === 'mousedown'
        ? Math.max(1, Math.floor(request.clickCount ?? 1))
        : undefined,
      modifiers,
    })
    return
  }

  if (type === 'keyDown' || type === 'keydown' || type === 'keyUp' || type === 'keyup' || type === 'char') {
    if (typeof request.keyCode !== 'string' || !request.keyCode) {
      throw new Error('keyCode is required for keyboard input events')
    }
    await handle.sendCdp('Input.dispatchKeyEvent', {
      type: cdpKeyEventType(type),
      key: request.keyCode,
      code: request.keyCode,
      text: type === 'char' ? request.keyCode : undefined,
      modifiers,
    })
    return
  }

  throw new Error(`Unknown input event type: ${type}`)
}

function cdpMouseButton(button: string | undefined): 'left' | 'middle' | 'right' | 'none' {
  if (button === 'left' || button === 'middle' || button === 'right') return button
  return 'left'
}

function cdpMouseEventType(type: string): 'mousePressed' | 'mouseReleased' | 'mouseMoved' {
  switch (type) {
    case 'mouseDown':
    case 'mousedown':
      return 'mousePressed'
    case 'mouseUp':
    case 'mouseup':
      return 'mouseReleased'
    default:
      return 'mouseMoved'
  }
}

function cdpKeyEventType(type: string): 'keyDown' | 'keyUp' | 'char' {
  if (type === 'keyUp' || type === 'keyup') return 'keyUp'
  if (type === 'char') return 'char'
  return 'keyDown'
}

function cdpModifierMask(modifiers: string[] | undefined): number {
  let mask = 0
  for (const modifier of modifiers ?? []) {
    if (modifier === 'alt') mask |= 1
    if (modifier === 'control') mask |= 2
    if (modifier === 'meta') mask |= 4
    if (modifier === 'shift') mask |= 8
  }
  return mask
}

export async function inspect(handle: BrowserPageHandle, selector: string): Promise<unknown> {
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
  handle: BrowserPageHandle,
  request?: { since?: number; limit?: number },
): Promise<TabConsoleLog[]> {
  if (handle.getConsoleLogs) {
    return handle.getConsoleLogs(request)
  }
  return []
}
