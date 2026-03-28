import { execSync } from 'child_process'
import { existsSync, symlinkSync } from 'fs'
import { join } from 'path'

export function ensureVendor(root) {
  const needsVendor = !existsSync(join(root, 'vendor'))
  const needsNodeModules = !existsSync(join(root, 'node_modules'))
  if (!needsVendor && !needsNodeModules) return
  try {
    const main = execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf-8' })
      .split('\n')[0]?.replace('worktree ', '')
    if (!main || main === root) return
    if (needsVendor && existsSync(join(main, 'vendor'))) {
      symlinkSync(join(main, 'vendor'), join(root, 'vendor'))
    }
    if (needsNodeModules && existsSync(join(main, 'node_modules'))) {
      symlinkSync(join(main, 'node_modules'), join(root, 'node_modules'))
    }
  } catch {}
}
