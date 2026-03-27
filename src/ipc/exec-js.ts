import { JsRuntime, type JsRuntimeDeps } from '../runtime/js_runtime.js'

const runtimes = new Map<string, JsRuntime>()

export function getOrCreateRuntime(agentRoot: string, deps: JsRuntimeDeps): JsRuntime {
  let runtime = runtimes.get(agentRoot)
  if (runtime) return runtime

  runtime = new JsRuntime(deps)
  runtimes.set(agentRoot, runtime)

  return runtime
}

export function disposeRuntime(agentRoot: string): void {
  const r = runtimes.get(agentRoot)
  if (r) {
    r.disposeAll()
    runtimes.delete(agentRoot)
  }
}
