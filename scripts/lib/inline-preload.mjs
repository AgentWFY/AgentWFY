import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Electron's sandboxed preload can only require() built-in modules.
// Inline channels.cjs so the preload is self-contained.
export function inlinePreload(dist) {
  const preloadPath = join(dist, 'preload.cjs')
  let preloadCode = readFileSync(preloadPath, 'utf-8')

  const channelsCode = readFileSync(join(dist, 'ipc', 'channels.cjs'), 'utf-8')
  const channelsMatch = channelsCode.match(/exports\.Channels\s*=\s*(\{[\s\S]*?\});/)
  if (!channelsMatch) throw new Error('Failed to extract Channels from dist/ipc/channels.cjs')

  const requirePattern = /const channels_cjs_1 = require\("\.\/ipc\/channels\.cjs"\);/
  if (!requirePattern.test(preloadCode)) throw new Error('Preload channels require() not found — compiler output may have changed')

  preloadCode = preloadCode.replace(
    requirePattern,
    `const channels_cjs_1 = { Channels: ${channelsMatch[1]} };`,
  )
  writeFileSync(preloadPath, preloadCode)
}

// Allow running as a standalone script: `node scripts/lib/inline-preload.mjs <dist>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = process.argv[2]
  if (!dist) {
    console.error('Usage: inline-preload.mjs <dist-dir>')
    process.exit(1)
  }
  inlinePreload(dist)
}
