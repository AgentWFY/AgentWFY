import { formatTimeoutError, resolveTimeout } from '../runtime/timeout_utils.js'

export const PAGE_JS_DEFAULT_TIMEOUT_MS = 5000
export const PAGE_JS_MAX_TIMEOUT_MS = 120_000

type AsyncFunctionConstructor = new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor

export function buildPageExecutionCode(code: string): string {
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

export function resolvePageJsTimeout(timeoutMs?: number): { timeoutMs: number; wasDefault: boolean } {
  const { timeoutMs: requestedTimeout, wasDefault } = resolveTimeout(timeoutMs, PAGE_JS_DEFAULT_TIMEOUT_MS)
  return {
    timeoutMs: Math.max(1, Math.min(requestedTimeout, PAGE_JS_MAX_TIMEOUT_MS)),
    wasDefault,
  }
}

export function withPageJsTimeout<T>(promise: Promise<T>, timeoutMs: number, wasDefault: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(formatTimeoutError('runPageJs', timeoutMs, wasDefault, PAGE_JS_MAX_TIMEOUT_MS)))
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

export function readCdpRemoteObjectValue(result: unknown): unknown {
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
