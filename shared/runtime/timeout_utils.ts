export function resolveTimeout(
  requested: unknown,
  defaultMs: number,
): { timeoutMs: number; wasDefault: boolean } {
  const specified = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
  const timeoutMs = specified ? Math.floor(requested as number) : defaultMs
  return { timeoutMs, wasDefault: !specified }
}

export function formatTimeoutError(
  fnName: string,
  timeoutMs: number,
  wasDefault: boolean,
  maxMs: number,
): string {
  const qualifier = wasDefault ? 'default ' : ''
  return `${fnName} timed out after ${qualifier}${timeoutMs}ms (max ${maxMs}ms). ` +
    'Pass a larger `timeoutMs` or reduce work (bound loops, avoid per-iteration awaits).'
}
