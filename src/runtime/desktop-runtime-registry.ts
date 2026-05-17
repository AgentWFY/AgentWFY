import { JsRuntime, type JsRuntimeDeps } from '#shared/runtime/js_runtime.js'
import { TraceWriter } from '#shared/runtime/trace_writer.js'
import { getTraceDir } from '#shared/runtime/trace_paths.js'

const runtimes = new Map<string, JsRuntime>()
const traceWriters = new Map<string, TraceWriter>()

export function getOrCreateDesktopTraceWriter(runtimeRoot: string): TraceWriter {
  let writer = traceWriters.get(runtimeRoot)
  if (writer) return writer
  writer = new TraceWriter(getTraceDir(runtimeRoot))
  traceWriters.set(runtimeRoot, writer)
  return writer
}

export function getOrCreateDesktopRuntime(runtimeRoot: string, deps: JsRuntimeDeps): JsRuntime {
  let runtime = runtimes.get(runtimeRoot)
  if (runtime) return runtime

  runtime = new JsRuntime(deps)
  runtimes.set(runtimeRoot, runtime)

  return runtime
}

export function disposeDesktopRuntime(runtimeRoot: string): void {
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
 * most recent buffered trace records land on disk — the sync
 * disposeDesktopRuntime path fires-and-forgets, which loses records if the
 * process exits first.
 */
export async function flushDesktopTraceWriters(): Promise<void> {
  const writers = Array.from(traceWriters.values())
  await Promise.allSettled(writers.map((w) => w.flush()))
}
