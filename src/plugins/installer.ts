import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'
import { getOrCreateAgentDb } from '../db/agent-db.js'

interface PackagePlugin {
  name: string
  description: string
  version: string
  code: string
}

interface PackageDoc {
  name: string
  content: string
}

interface PackageAsset {
  name: string
  data: Buffer
}

function readPackage(packagePath: string): {
  plugins: PackagePlugin[]
  docs: PackageDoc[]
  assets: PackageAsset[]
} {
  const db = new DatabaseSync(packagePath)
  try {
    const plugins = db.prepare('SELECT name, description, version, code FROM plugins').all() as unknown as PackagePlugin[]

    let docs: PackageDoc[] = []
    try {
      docs = db.prepare('SELECT name, content FROM docs').all() as unknown as PackageDoc[]
    } catch {
      // docs table is optional
    }

    let assets: PackageAsset[] = []
    try {
      assets = db.prepare('SELECT name, data FROM assets').all() as unknown as PackageAsset[]
    } catch {
      // assets table is optional
    }

    return { plugins, docs, assets }
  } finally {
    db.close()
  }
}

function validatePackage(
  plugins: PackagePlugin[],
  docs: PackageDoc[],
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
    if (typeof p.code !== 'string' || p.code.trim().length === 0) {
      errors.push(`Plugin '${p.name}' has missing or empty code`)
    }
    if (pluginNames.has(p.name)) {
      errors.push(`Duplicate plugin name '${p.name}'`)
    }
    pluginNames.add(p.name)
  }

  for (const d of docs) {
    if (typeof d.name !== 'string' || !d.name.startsWith('plugin.')) {
      errors.push(`Doc '${d.name}' must start with 'plugin.'`)
      continue
    }
    // Extract plugin name: 'plugin.foo' → 'foo', 'plugin.foo.bar' → 'foo'
    const parts = d.name.split('.')
    const docPluginName = parts[1]
    if (!pluginNames.has(docPluginName)) {
      errors.push(`Doc '${d.name}' references unknown plugin '${docPluginName}'`)
    }
  }

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

export function installFromPackage(agentRoot: string, packagePath: string): { installed: string[] } {
  const { plugins, docs, assets } = readPackage(packagePath)

  const errors = validatePackage(plugins, docs, assets)
  if (errors.length > 0) {
    throw new Error(`Invalid plugin package:\n${errors.join('\n')}`)
  }

  const db = getOrCreateAgentDb(agentRoot)
  db.installPlugins(plugins, docs)

  // Extract assets to plugin-assets/<plugin>/<path>
  for (const asset of assets) {
    const slashIdx = asset.name.indexOf('/')
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
