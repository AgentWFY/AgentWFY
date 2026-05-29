// Per-agent server config — stored in the agent's .agentwfy/ directory so
// it travels with the agent. Holds the daemon's bearer token (and any
// future per-agent server settings). Read at daemon startup; CLI
// subcommands write to it.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const CONFIG_FILE_NAME = 'remote-server.json'
const AGENT_DIR_NAME = '.agentwfy'

export interface RemoteServerConfig {
  token: string
  createdAt: number
}

function configPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, AGENT_DIR_NAME, CONFIG_FILE_NAME)
}

export function configExists(runtimeRoot: string): boolean {
  return existsSync(configPath(runtimeRoot))
}

export function readConfig(runtimeRoot: string): RemoteServerConfig | null {
  let text: string
  try {
    text = readFileSync(configPath(runtimeRoot), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
  try {
    const raw = JSON.parse(text)
    if (typeof raw?.token !== 'string' || raw.token.length === 0) return null
    return {
      token: raw.token,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function writeConfig(runtimeRoot: string, config: RemoteServerConfig): void {
  const dir = path.join(runtimeRoot, AGENT_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const p = configPath(runtimeRoot)
  writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  try {
    chmodSync(p, 0o600)
  } catch {
    // Best effort on platforms that don't honor chmod.
  }
}

export function generateToken(): string {
  // 32 bytes → 43-char URL-safe base64 string.
  return crypto.randomBytes(32).toString('base64url')
}
