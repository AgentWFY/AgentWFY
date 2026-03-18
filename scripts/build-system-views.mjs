import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function buildSystemViews(distDir) {
  const viewsDir = join(__dirname, '..', 'src', 'system-views')
  const outPath = join(distDir, 'system-views.json')

  const files = readdirSync(viewsDir).filter(f => f.endsWith('.html')).sort()
  const views = []

  for (const file of files) {
    const content = readFileSync(join(viewsDir, file), 'utf-8')
    const name = file.replace(/\.html$/, '')
    // Title from <title> tag if present, otherwise last segment capitalized
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i)
    let title
    if (titleMatch) {
      title = titleMatch[1].trim()
    } else {
      const segments = name.split('.')
      const lastSegment = segments[segments.length - 1]
      title = lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1)
    }
    views.push({ name, title, content })
  }

  writeFileSync(outPath, JSON.stringify(views))
  console.log(`[system-views] Built ${views.length} views`)
}
