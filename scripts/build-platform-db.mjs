import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function buildPlatformDb(distDir) {
  const docsDir = join(__dirname, '..', 'src', 'platform-docs')
  const dbPath = join(distDir, 'platform.db')

  // Remove existing DB if present
  if (existsSync(dbPath)) {
    unlinkSync(dbPath)
  }

  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE docs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      preload INTEGER NOT NULL DEFAULT 0 CHECK(preload IN (0, 1)),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
    );
  `)

  const files = readdirSync(docsDir).filter(f => f.endsWith('.md')).sort()
  const insert = db.prepare('INSERT INTO docs (id, name, content, preload, updated_at) VALUES (?, ?, ?, ?, unixepoch())')

  let nextId = -1
  for (const file of files) {
    const raw = readFileSync(join(docsDir, file), 'utf-8')
    const name = file.replace(/\.md$/, '')

    // Parse frontmatter
    let preload = 0
    let content = raw
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (fmMatch) {
      const frontmatter = fmMatch[1]
      content = fmMatch[2].trimStart()
      const preloadMatch = frontmatter.match(/preload:\s*(\d+)/)
      if (preloadMatch) {
        preload = parseInt(preloadMatch[1], 10)
      }
    }

    insert.run(nextId, name, content, preload)
    nextId--
  }

  db.close()
  console.log(`[platform-db] Built ${files.length} docs → ${dbPath}`)
}
