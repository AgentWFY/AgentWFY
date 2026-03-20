import * as esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildSystemDocs } from './build-system-docs.mjs'
import { buildSystemViews } from './build-system-views.mjs'
import { buildSystemConfig } from './build-system-config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const src = join(root, 'src')
const dist = join(root, 'dist')
const clientDist = join(dist, 'client')

const watch = process.argv.includes('--watch')

// ── Static assets ──

mkdirSync(clientDist, { recursive: true })
mkdirSync(join(dist, 'command-palette'), { recursive: true })
mkdirSync(join(dist, 'confirmation'), { recursive: true })

cpSync(join(src, 'renderer', 'index.html'), join(clientDist, 'index.html'))
cpSync(join(src, 'renderer', 'src', 'global.css'), join(clientDist, 'global.css'))
cpSync(join(src, 'command_palette.html'), join(dist, 'command_palette.html'))
cpSync(join(src, 'confirmation.html'), join(dist, 'confirmation.html'))
cpSync(join(src, 'index.css'), join(dist, 'index.css'))

// ── System data ──

buildSystemDocs(dist)
buildSystemViews(dist)
buildSystemConfig(dist)

// ── Build configs ──

const builds = [
  // Main process
  {
    entryPoints: [join(src, 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: dist,
    external: ['electron'],
    sourcemap: watch,
    logLevel: 'info',
  },
  // Preload (main)
  {
    entryPoints: [join(src, 'preload.cts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    outdir: dist,
    external: ['electron'],
    sourcemap: watch,
    logLevel: 'info',
  },
  // Preload (command palette)
  {
    entryPoints: [join(src, 'command-palette', 'preload.cts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    outdir: join(dist, 'command-palette'),
    external: ['electron'],
    sourcemap: watch,
    logLevel: 'info',
  },
  // Renderer
  {
    entryPoints: [join(src, 'renderer', 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    outdir: clientDist,
    define: { 'process.env': '{}', 'process.versions': '{}' },
    sourcemap: watch,
    logLevel: 'info',
  },
  // Exec worker (utilityProcess)
  {
    entryPoints: [join(src, 'runtime', 'exec_worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: dist,
    external: ['electron'],
    sourcemap: watch,
    logLevel: 'info',
  },
  // Command Palette UI
  {
    entryPoints: [join(src, 'command-palette', 'ui', 'index.ts')],
    bundle: true,
    format: 'esm',
    outfile: join(clientDist, 'command_palette.js'),
    define: { 'process.env': '{}', 'process.versions': '{}' },
    sourcemap: watch,
    logLevel: 'info',
  },
  // Confirmation preload
  {
    entryPoints: [join(src, 'confirmation', 'preload.cts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    outdir: join(dist, 'confirmation'),
    external: ['electron'],
    sourcemap: watch,
    logLevel: 'info',
  },
  // Confirmation UI
  {
    entryPoints: [join(src, 'confirmation', 'ui', 'index.ts')],
    bundle: true,
    format: 'esm',
    outfile: join(clientDist, 'confirmation.js'),
    define: { 'process.env': '{}', 'process.versions': '{}' },
    sourcemap: watch,
    logLevel: 'info',
  },
]

// ── Execute ──

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)))
  await Promise.all(contexts.map((ctx) => ctx.watch()))
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)))
}
