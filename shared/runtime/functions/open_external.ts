import type { FunctionRegistry } from '../function_registry.js'
import type { ExternalLauncher } from '../hosts.js'

export function registerOpenExternal(registry: FunctionRegistry, launcher: ExternalLauncher): void {
  registry.register('openExternal', async (params) => {
    const { url } = params as { url: string }
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new Error('openExternal requires a non-empty url string')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Invalid URL passed to openExternal')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('openExternal only supports http/https URLs')
    }
    await launcher.openExternal(parsed.toString())
  })
}
