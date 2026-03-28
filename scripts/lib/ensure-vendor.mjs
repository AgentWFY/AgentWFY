import { execSync } from 'child_process'
import { existsSync, symlinkSync } from 'fs'
import { join } from 'path'

export function ensureVendor(root) {
  if (existsSync(join(root, 'vendor'))) return
  try {
    const main = execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf-8' })
      .split('\n')[0]?.replace('worktree ', '')
    if (main && main !== root && existsSync(join(main, 'vendor'))) {
      symlinkSync(join(main, 'vendor'), join(root, 'vendor'))
    }
  } catch {}
}
