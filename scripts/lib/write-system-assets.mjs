import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export function writeSystemAssets(projectRoot, outDir) {
  const shared = join(projectRoot, 'shared')

  mkdirSync(outDir, { recursive: true })

  const docsDir = join(shared, 'system-docs')
  const docFiles = readdirSync(docsDir).filter(f => f.endsWith('.md')).sort()
  const docs = docFiles.map(f => ({
    name: f.replace(/\.md$/, ''),
    content: readFileSync(join(docsDir, f), 'utf-8'),
  }))
  writeFileSync(join(outDir, 'system-docs.json'), JSON.stringify(docs))

  const viewsDir = join(shared, 'system-views')
  const viewFiles = readdirSync(viewsDir).filter(f => f.endsWith('.html')).sort()
  const views = viewFiles.map(f => {
    const content = readFileSync(join(viewsDir, f), 'utf-8')
    const name = f.replace(/\.html$/, '')
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : name.split('.').pop().charAt(0).toUpperCase() + name.split('.').pop().slice(1)
    return { name, title, content }
  })
  writeFileSync(join(outDir, 'system-views.json'), JSON.stringify(views))

  const configData = readFileSync(join(shared, 'system-config', 'system-config.json'), 'utf-8')
  const configItems = JSON.parse(configData)
  writeFileSync(join(outDir, 'system-config.json'), JSON.stringify(configItems))
}
