import path from 'path'
import { JsRuntime, type JsRuntimeDeps } from '../runtime/js_runtime.js'
import { TraceWriter } from '../runtime/trace_writer.js'

const runtimes = new Map<string, JsRuntime>()
const traceWriters = new Map<string, TraceWriter>()

export const TRACES_DIR_NAME = '.agentwfy/traces'

export function getOrCreateTraceWriter(agentRoot: string): TraceWriter {
  let writer = traceWriters.get(agentRoot)
  if (writer) return writer
  writer = new TraceWriter(path.join(agentRoot, TRACES_DIR_NAME))
  traceWriters.set(agentRoot, writer)
  return writer
}

export function getOrCreateRuntime(agentRoot: string, deps: Omit<JsRuntimeDeps, 'traceWriter'>): JsRuntime {
  let runtime = runtimes.get(agentRoot)
  if (runtime) return runtime

  const traceWriter = getOrCreateTraceWriter(agentRoot)
  runtime = new JsRuntime({ ...deps, traceWriter })
  runtimes.set(agentRoot, runtime)

  return runtime
}

export function disposeRuntime(agentRoot: string): void {
  const r = runtimes.get(agentRoot)
  if (r) {
    r.disposeAll()
    runtimes.delete(agentRoot)
  }
  const w = traceWriters.get(agentRoot)
  if (w) {
    void w.flush()
    traceWriters.delete(agentRoot)
  }
}

/**
 * Await every active trace writer's pending queue. Call before shutdown so the
 * most recent buffered trace records land on disk — the sync disposeRuntime
 * path fires-and-forgets, which loses records if the process exits first.
 */
export async function flushAllTraceWriters(): Promise<void> {
  const writers = Array.from(traceWriters.values())
  await Promise.allSettled(writers.map((w) => w.flush()))
}
