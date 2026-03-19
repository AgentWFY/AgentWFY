import type { BrowserWindow } from 'electron'
import { JsRuntime, type JsRuntimeDeps } from '../runtime/js_runtime.js'

const runtimes = new Map<number, JsRuntime>()

export function getOrCreateRuntime(win: BrowserWindow, deps: JsRuntimeDeps): JsRuntime {
  let runtime = runtimes.get(win.id)
  if (runtime) return runtime

  runtime = new JsRuntime(deps)
  runtimes.set(win.id, runtime)

  win.on('closed', () => {
    const r = runtimes.get(win.id)
    if (r) {
      r.disposeAll()
      runtimes.delete(win.id)
    }
  })

  return runtime
}
