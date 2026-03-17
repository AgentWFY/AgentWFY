import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function buildSystemConfig(distDir) {
  const srcPath = join(__dirname, '..', 'src', 'system-config', 'system-config.json')
  const outPath = join(distDir, 'system-config.json')

  const data = readFileSync(srcPath, 'utf-8')
  const items = JSON.parse(data)

  writeFileSync(outPath, JSON.stringify(items))
  console.log(`[system-config] Built ${items.length} config entries`)
}
