// Admin subcommands for agentwfy-server. Run as
//   node dist/server/index.js <subcommand> [args]
// Subcommands manage the per-agent config file (token, etc.); the daemon
// itself is started by the default subcommand (`start`, also the fallback).

import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import {
  configExists,
  generateToken,
  readConfig,
  writeConfig,
} from './config-file.js'

// Note: ensureViewsSchema and seedDefaultAgent are lazy-imported inside
// runInit so the `token` and `rotate` subcommands don't trigger node:sqlite's
// experimental-warning for operators who only manage tokens.

const USAGE = `
Usage:
  agentwfy-server start                 Start the server (default).
                                               Reads AGENTWFY_AGENT_ROOT and the
                                               per-agent config for the token.

  agentwfy-server init   <agent-root>   Create the agent directory,
                                               initialize schema, generate a
                                               first bearer token, and store
                                               it in <agent-root>/.agentwfy/.

  agentwfy-server token  <agent-root>   Print the current bearer token
                                               for the given agent.

  agentwfy-server rotate <agent-root>   Generate a new bearer token and
                                               replace the existing one.

Environment:
  AGENTWFY_AGENT_ROOT    Absolute path to the agent directory (required by start).
  AGENTWFY_REMOTE_PORT       TCP port to listen on (default 9878).
  AGENTWFY_REMOTE_HOST       Host/IP to bind (default 127.0.0.1).
  AGENTWFY_REMOTE_TOKEN      Override the per-agent config's token at runtime.
  AGENTWFY_REMOTE_TLS_CERT   Path to TLS cert PEM. If set with TLS_KEY, serves
                             HTTPS/WSS instead of HTTP/WS. Use e.g. the output
                             of: tailscale cert <hostname>
  AGENTWFY_REMOTE_TLS_KEY    Path to TLS private key PEM (pairs with TLS_CERT).
`.trim()

export function printUsage(): void {
  console.log(USAGE)
}

function requireRuntimeRoot(arg: string | undefined): string {
  if (!arg || arg.trim().length === 0) {
    console.error('error: missing <agent-root> argument\n')
    printUsage()
    process.exit(2)
  }
  return path.resolve(arg)
}

export async function runInit(runtimeRootArg: string | undefined): Promise<void> {
  const runtimeRoot = requireRuntimeRoot(runtimeRootArg)
  // Lazy imports — only init triggers SQLite loading.
  const { ensureViewsSchema } = await import('#shared/db/views.js')
  const { seedDefaultAgent } = await import('#shared/default-agent.js')

  await mkdir(path.join(runtimeRoot, '.agentwfy'), { recursive: true })
  await ensureViewsSchema(runtimeRoot)
  await seedDefaultAgent(runtimeRoot)

  if (configExists(runtimeRoot)) {
    const existing = readConfig(runtimeRoot)
    if (existing) {
      console.error(`error: ${runtimeRoot} already has a remote-server config.`)
      console.error('Run `agentwfy-server rotate <agent-root>` to issue a new token.')
      process.exit(1)
    }
  }

  const token = generateToken()
  writeConfig(runtimeRoot, { token, createdAt: Date.now() })

  console.log(`Initialized agent at ${runtimeRoot}`)
  console.log(`Bearer token: ${token}`)
  console.log('')
  console.log('Save this token — it will not be displayed again.')
  console.log('Start the server with:')
  console.log(`  AGENTWFY_AGENT_ROOT=${shellEscape(runtimeRoot)} agentwfy-server start`)
}

export function runShowToken(runtimeRootArg: string | undefined): void {
  const runtimeRoot = requireRuntimeRoot(runtimeRootArg)
  const config = readConfig(runtimeRoot)
  if (!config) {
    console.error(`error: no remote-server config at ${runtimeRoot}.`)
    console.error('Run `agentwfy-server init <agent-root>` first.')
    process.exit(1)
  }
  console.log(config.token)
}

export function runRotateToken(runtimeRootArg: string | undefined): void {
  const runtimeRoot = requireRuntimeRoot(runtimeRootArg)
  const existing = readConfig(runtimeRoot)
  if (!existing) {
    console.error(`error: no remote-server config at ${runtimeRoot}.`)
    console.error('Run `agentwfy-server init <agent-root>` first.')
    process.exit(1)
  }
  const token = generateToken()
  writeConfig(runtimeRoot, { token, createdAt: Date.now() })
  console.log(`Rotated bearer token for ${runtimeRoot}`)
  console.log(`New token: ${token}`)
  console.log('')
  console.log('Update all clients before restarting the server.')
}

function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
