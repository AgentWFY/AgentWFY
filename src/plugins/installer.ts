import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'
import { getOrCreateAgentDb } from '../db/agent-db.js'

const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const NAME_FORMAT_RE = /^[a-z0-9][a-z0-9._-]*$/

interface PackagePlugin {
  name: string
  title: string
  description: string
  version: string
  code: string
  author: string | null
  repository: string | null
  license: string | null
}

interface PackageDoc {
  name: string
  content: string
}

interface PackageView {
  name: string
  title: string
  content: string
}

interface PackageConfig {
  name: string
  value: string | null
  description: string
}

interface PackageAsset {
  name: string
  data: Buffer
}

function readPackage(packagePath: string): {
  plugins: PackagePlugin[]
  docs: PackageDoc[]
  views: PackageView[]
  config: PackageConfig[]
  assets: PackageAsset[]
} {
  const db = new DatabaseSync(packagePath)
  try {
    let plugins: PackagePlugin[]
    try {
      plugins = db.prepare('SELECT name, title, description, version, code, author, repository, license FROM plugins').all() as unknown as PackagePlugin[]
    } catch {
      // Fallback for packages without the newer columns
      try {
        const rows = db.prepare('SELECT name, description, version, code, author, repository, license FROM plugins').all() as unknown as Array<Omit<PackagePlugin, 'title'>>
        plugins = rows.map(p => ({ ...p, title: '' }))
      } catch {
        const basic = db.prepare('SELECT name, description, version, code FROM plugins').all() as unknown as Array<{ name: string; description: string; version: string; code: string }>
        plugins = basic.map(p => ({ ...p, title: '', author: null, repository: null, license: null }))
      }
    }

    let docs: PackageDoc[] = []
    try {
      docs = db.prepare('SELECT name, content FROM docs').all() as unknown as PackageDoc[]
    } catch {
      // docs table is optional
    }

    let views: PackageView[] = []
    try {
      views = db.prepare('SELECT name, title, content FROM views').all() as unknown as PackageView[]
    } catch {
      // views table is optional
    }

    let config: PackageConfig[] = []
    try {
      config = db.prepare('SELECT name, value, description FROM config').all() as unknown as PackageConfig[]
    } catch {
      // config table is optional
    }

    let assets: PackageAsset[] = []
    try {
      assets = db.prepare('SELECT name, data FROM assets').all() as unknown as PackageAsset[]
    } catch {
      // assets table is optional
    }

    return { plugins, docs, views, config, assets }
  } finally {
    db.close()
  }
}

function validatePluginNames(
  items: Array<{ name: string }>,
  type: string,
  pluginNames: Set<string>,
  errors: string[],
): void {
  for (const item of items) {
    if (typeof item.name !== 'string' || !item.name.startsWith('plugin.')) {
      errors.push(`${type} '${item.name}' must start with 'plugin.'`)
      continue
    }
    if (!NAME_FORMAT_RE.test(item.name)) {
      errors.push(`${type} name '${item.name}' must contain only lowercase letters, digits, dots, hyphens, and underscores`)
    }
    const pluginName = item.name.split('.')[1]
    if (!pluginNames.has(pluginName)) {
      errors.push(`${type} '${item.name}' references unknown plugin '${pluginName}'`)
    }
  }
}

function validatePackage(
  plugins: PackagePlugin[],
  docs: PackageDoc[],
  views: PackageView[],
  config: PackageConfig[],
  assets: PackageAsset[],
): string[] {
  const errors: string[] = []

  if (plugins.length === 0) {
    errors.push('Package contains no plugins')
    return errors
  }

  const pluginNames = new Set<string>()
  for (const p of plugins) {
    if (typeof p.name !== 'string' || p.name.trim().length === 0) {
      errors.push('Plugin has missing or empty name')
      continue
    }
    if (!PLUGIN_NAME_RE.test(p.name)) {
      errors.push(`Plugin name '${p.name}' must contain only lowercase letters, digits, and hyphens`)
    }
    if (typeof p.code !== 'string' || p.code.trim().length === 0) {
      errors.push(`Plugin '${p.name}' has missing or empty code`)
    }
    if (pluginNames.has(p.name)) {
      errors.push(`Duplicate plugin name '${p.name}'`)
    }
    pluginNames.add(p.name)
  }

  validatePluginNames(docs, 'Doc', pluginNames, errors)
  validatePluginNames(views, 'View', pluginNames, errors)
  validatePluginNames(config, 'Config', pluginNames, errors)

  for (const a of assets) {
    if (typeof a.name !== 'string' || !a.name.includes('/')) {
      errors.push(`Asset '${a.name}' must use '<plugin>/<filename>' format`)
      continue
    }
    const assetPluginName = a.name.split('/')[0]
    if (!pluginNames.has(assetPluginName)) {
      errors.push(`Asset '${a.name}' references unknown plugin '${assetPluginName}'`)
    }
  }

  return errors
}

export function readPackageMetadata(packagePath: string): { plugins: Array<{ name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null }> } {
  const { plugins, docs, views, config, assets } = readPackage(packagePath)

  const errors = validatePackage(plugins, docs, views, config, assets)
  if (errors.length > 0) {
    throw new Error(`Invalid plugin package:\n${errors.join('\n')}`)
  }

  return {
    plugins: plugins.map(p => ({ name: p.name, title: p.title, description: p.description, version: p.version, author: p.author, repository: p.repository, license: p.license })),
  }
}

export function installFromPackage(agentRoot: string, packagePath: string): { installed: string[] } {
  const { plugins, docs, views, config, assets } = readPackage(packagePath)

  const errors = validatePackage(plugins, docs, views, config, assets)
  if (errors.length > 0) {
    throw new Error(`Invalid plugin package:\n${errors.join('\n')}`)
  }

  const db = getOrCreateAgentDb(agentRoot)
  db.installPlugins(plugins, docs, views, config)

  // Extract assets to plugin-assets/<plugin>/<path>
  for (const asset of assets) {
    const filePath = path.join(agentRoot, '.agentwfy', 'plugin-assets', asset.name)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, asset.data)
  }

  return { installed: plugins.map(p => p.name) }
}

export function uninstallPlugin(agentRoot: string, pluginName: string): void {
  const db = getOrCreateAgentDb(agentRoot)
  db.uninstallPlugin(pluginName)

  // Remove plugin assets directory
  const assetsDir = path.join(agentRoot, '.agentwfy', 'plugin-assets', pluginName)
  try {
    fs.rmSync(assetsDir, { recursive: true })
  } catch {
    // Directory may not exist
  }
}
