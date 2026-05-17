import path from 'path'
import { JsRuntime, type JsRuntimeDeps } from '#shared/runtime/js_runtime.js'
import { TraceWriter } from '#shared/runtime/trace_writer.js'

const runtimes = new Map<string, JsRuntime>()
const traceWriters = new Map<string, TraceWriter>()

const TRACES_DIR_NAME = '.agentwfy/traces'

export function getOrCreateTraceWriter(runtimeRoot: string): TraceWriter {
  let writer = traceWriters.get(runtimeRoot)
  if (writer) return writer
  writer = new TraceWriter(path.join(runtimeRoot, TRACES_DIR_NAME))
  traceWriters.set(runtimeRoot, writer)
  return writer
}

export function getOrCreateRuntime(runtimeRoot: string, deps: Omit<JsRuntimeDeps, 'traceWriter'>): JsRuntime {
  let runtime = runtimes.get(runtimeRoot)
  if (runtime) return runtime

  const traceWriter = getOrCreateTraceWriter(runtimeRoot)
  runtime = new JsRuntime({ ...deps, traceWriter })
  runtimes.set(runtimeRoot, runtime)

  return runtime
}

export function disposeRuntime(runtimeRoot: string): void {
  const r = runtimes.get(runtimeRoot)
  if (r) {
    r.disposeAll()
    runtimes.delete(runtimeRoot)
  }
  const w = traceWriters.get(runtimeRoot)
  if (w) {
    void w.flush()
    traceWriters.delete(runtimeRoot)
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
