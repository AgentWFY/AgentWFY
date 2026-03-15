#!/usr/bin/env node

/**
 * Downloads static ffmpeg binaries for all supported platforms into resources/bin/.
 *
 * Usage:
 *   node scripts/download-ffmpeg.mjs            # download all platforms
 *   node scripts/download-ffmpeg.mjs darwin-arm64  # download specific platform
 *
 * Supported platforms: darwin-arm64, darwin-x64, linux-x64, win32-x64
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { pipeline } from 'stream/promises'
import { createWriteStream } from 'fs'

const BIN_DIR = path.join(import.meta.dirname, '..', 'resources', 'bin')

const PLATFORMS = {
  'darwin-arm64': {
    url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1766430132_8.0.1/ffmpeg.zip',
    archive: 'zip',
    binaryInArchive: 'ffmpeg',
    output: 'ffmpeg-darwin-arm64',
  },
  'darwin-x64': {
    url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1766437297_8.0.1/ffmpeg.zip',
    archive: 'zip',
    binaryInArchive: 'ffmpeg',
    output: 'ffmpeg-darwin-x64',
  },
  'linux-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.0-latest-linux64-gpl-8.0.tar.xz',
    archive: 'tar.xz',
    binaryInArchive: '*/bin/ffmpeg',
    output: 'ffmpeg-linux-x64',
  },
  'win32-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.0-latest-win64-gpl-8.0.zip',
    archive: 'zip',
    binaryInArchive: '*/bin/ffmpeg.exe',
    output: 'ffmpeg-win32-x64.exe',
  },
}

async function download(url, destPath) {
  console.log(`  Downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  await pipeline(res.body, createWriteStream(destPath))
}

async function extractBinary(archivePath, archiveType, binaryPattern, outputPath) {
  const tmpDir = archivePath + '_extracted'
  fs.mkdirSync(tmpDir, { recursive: true })

  try {
    if (archiveType === 'zip') {
      execSync(`unzip -o -q "${archivePath}" -d "${tmpDir}"`)
    } else if (archiveType === 'tar.xz') {
      execSync(`tar -xf "${archivePath}" -C "${tmpDir}"`)
    }

    // Find the binary using the glob pattern
    const found = execSync(`find "${tmpDir}" -path "${tmpDir}/${binaryPattern}" -type f`, {
      encoding: 'utf-8',
    }).trim().split('\n')[0]

    if (!found) throw new Error(`Binary not found in archive matching: ${binaryPattern}`)

    fs.copyFileSync(found, outputPath)
    fs.chmodSync(outputPath, 0o755)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function downloadPlatform(platformKey) {
  const config = PLATFORMS[platformKey]
  if (!config) {
    console.error(`Unknown platform: ${platformKey}`)
    console.error(`Available: ${Object.keys(PLATFORMS).join(', ')}`)
    process.exit(1)
  }

  const outputPath = path.join(BIN_DIR, config.output)
  if (fs.existsSync(outputPath)) {
    console.log(`  ${config.output} already exists, skipping (delete to re-download)`)
    return
  }

  const ext = config.archive === 'tar.xz' ? '.tar.xz' : '.zip'
  const archivePath = path.join(BIN_DIR, `_tmp_${platformKey}${ext}`)

  try {
    await download(config.url, archivePath)
    console.log(`  Extracting ${config.output}...`)
    await extractBinary(archivePath, config.archive, config.binaryInArchive, outputPath)
    console.log(`  Done: ${outputPath}`)
  } finally {
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath)
  }
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true })

  const requestedPlatform = process.argv[2]
  const platforms = requestedPlatform ? [requestedPlatform] : Object.keys(PLATFORMS)

  await Promise.all(platforms.map(async (platform) => {
    console.log(`[${platform}]`)
    await downloadPlatform(platform)
  }))

  console.log('\nAll done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
