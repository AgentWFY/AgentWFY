import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function buildPlatformDocs(distDir) {
  const docsDir = join(__dirname, '..', 'src', 'platform-docs')
  const outPath = join(distDir, 'platform-docs.json')

  const files = readdirSync(docsDir).filter(f => f.endsWith('.md')).sort()
  const docs = []

  for (const file of files) {
    const content = readFileSync(join(docsDir, file), 'utf-8')
    const name = file.replace(/\.md$/, '')
    docs.push({ name, content })
  }

  writeFileSync(outPath, JSON.stringify(docs))
  console.log(`[platform-docs] Built ${docs.length} docs → ${outPath}`)
}
