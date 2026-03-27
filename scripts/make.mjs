// Create distributable files from a packaged app.
// macOS: .dmg (+ optional code signing & notarization)
// Linux: .deb
// Windows: Setup.exe via NSIS

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'out')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const APP_NAME = 'AgentWFY'
const VERSION = pkg.version

const platform = process.argv.includes('--platform')
  ? process.argv[process.argv.indexOf('--platform') + 1]
  : process.platform

const arch = process.argv.includes('--arch')
  ? process.argv[process.argv.indexOf('--arch') + 1]
  : process.arch

const platformOutDir = join(outDir, `${APP_NAME}-${platform}-${arch}`)
const makeDir = join(outDir, 'make')
mkdirSync(makeDir, { recursive: true })

if (!existsSync(platformOutDir)) {
  console.error(`Packaged app not found at ${platformOutDir}. Run \`npm run package\` first.`)
  process.exit(1)
}

console.log(`Making distributable for ${platform}-${arch}...`)

if (platform === 'darwin') {
  makeMacOS()
} else if (platform === 'linux') {
  makeLinux()
} else if (platform === 'win32') {
  makeWindows()
} else {
  console.error(`Unsupported platform: ${platform}`)
  process.exit(1)
}

// ── macOS ──

function makeMacOS() {
  const appBundle = join(platformOutDir, `${APP_NAME}.app`)

  // Code signing (if APPLE_TEAM_ID is set)
  if (process.env.APPLE_TEAM_ID) {
    signMacOS(appBundle)
    notarizeMacOS(appBundle)
  }

  // Create DMG
  const dmgPath = join(makeDir, `${APP_NAME}-${VERSION}-${arch}.dmg`)
  console.log(`Creating DMG: ${dmgPath}`)

  // Create a temporary directory for DMG contents
  const dmgStaging = join(outDir, 'dmg-staging')
  execSync(`rm -rf "${dmgStaging}"`)
  execSync(`mkdir -p "${dmgStaging}"`)
  execSync(`cp -R "${appBundle}" "${dmgStaging}/"`)
  execSync(`ln -s /Applications "${dmgStaging}/Applications"`)

  execSync(`hdiutil create -volname "${APP_NAME}" -srcfolder "${dmgStaging}" -ov -format UDZO "${dmgPath}"`)
  execSync(`rm -rf "${dmgStaging}"`)
  console.log(`Created: ${dmgPath}`)

  // Create .zip for auto-updates
  const zipPath = join(makeDir, `${APP_NAME}-${VERSION}-${arch}-mac.zip`)
  console.log(`Creating ZIP: ${zipPath}`)
  execSync(`ditto -c -k --keepParent "${appBundle}" "${zipPath}"`)
  console.log(`Created: ${zipPath}`)
}

function signMacOS(appBundle) {
  const identity = process.env.APPLE_IDENTITY || 'Developer ID Application'
  console.log(`Signing with identity: ${identity}`)

  // Sign all helper apps first (deepest first)
  const frameworks = join(appBundle, 'Contents', 'Frameworks')
  const helpers = [
    `${APP_NAME} Helper (GPU).app`,
    `${APP_NAME} Helper (Plugin).app`,
    `${APP_NAME} Helper (Renderer).app`,
    `${APP_NAME} Helper.app`,
  ]

  for (const helper of helpers) {
    const helperPath = join(frameworks, helper)
    if (existsSync(helperPath)) {
      execSync(`codesign --sign "${identity}" --force --timestamp --options runtime "${helperPath}"`)
    }
  }

  // Sign frameworks
  execSync(`find "${frameworks}" -name "*.framework" -exec codesign --sign "${identity}" --force --timestamp {} \\;`)

  // Sign main app
  execSync(`codesign --sign "${identity}" --force --timestamp --options runtime "${appBundle}"`)

  // Verify
  execSync(`codesign --verify --deep --strict "${appBundle}"`)
  console.log('Code signing verified.')
}

function notarizeMacOS(appBundle) {
  const appleId = process.env.APPLE_ID
  const applePassword = process.env.APPLE_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID

  if (!appleId || !applePassword) {
    console.log('Skipping notarization (APPLE_ID or APPLE_PASSWORD not set)')
    return
  }

  console.log('Submitting for notarization...')

  // Create a zip for notarization
  const zipPath = join(outDir, `${APP_NAME}-notarize.zip`)
  execSync(`ditto -c -k --keepParent "${appBundle}" "${zipPath}"`)

  // Submit
  execSync(
    `xcrun notarytool submit "${zipPath}" --apple-id "${appleId}" --password "${applePassword}" --team-id "${teamId}" --wait`,
    { stdio: 'inherit' }
  )

  // Staple
  execSync(`xcrun stapler staple "${appBundle}"`)
  execSync(`rm "${zipPath}"`)

  console.log('Notarization complete.')
}

// ── Linux ──

function makeLinux() {
  const debPath = join(makeDir, `agentwfy_${VERSION}_${arch === 'x64' ? 'amd64' : arch}.deb`)
  console.log(`Creating deb: ${debPath}`)

  const staging = join(outDir, 'deb-staging')
  execSync(`rm -rf "${staging}"`)

  // Create directory structure
  const dirs = [
    `${staging}/DEBIAN`,
    `${staging}/usr/lib/agentwfy`,
    `${staging}/usr/bin`,
    `${staging}/usr/share/applications`,
    `${staging}/usr/share/icons/hicolor/256x256/apps`,
  ]
  for (const d of dirs) mkdirSync(d, { recursive: true })

  // Copy app files
  execSync(`cp -R "${platformOutDir}/." "${staging}/usr/lib/agentwfy/"`)

  // Create symlink for PATH
  execSync(`ln -s /usr/lib/agentwfy/agentwfy "${staging}/usr/bin/agentwfy"`)

  // Copy icon
  execSync(`cp "${join(root, 'icons', 'icon.png')}" "${staging}/usr/share/icons/hicolor/256x256/apps/agentwfy.png"`)

  // Desktop file
  const desktop = `[Desktop Entry]
Name=${APP_NAME}
Exec=/usr/bin/agentwfy
Icon=agentwfy
Type=Application
Categories=Development;
`
  execSync(`cat > "${staging}/usr/share/applications/agentwfy.desktop" << 'DESKTOP'\n${desktop}DESKTOP`)

  // Control file
  const control = `Package: agentwfy
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: ${arch === 'x64' ? 'amd64' : arch}
Maintainer: ${pkg.author?.name || 'Unknown'} <${pkg.author?.email || ''}>
Description: ${pkg.description || APP_NAME}
`
  execSync(`cat > "${staging}/DEBIAN/control" << 'CONTROL'\n${control}CONTROL`)

  execSync(`dpkg-deb --build "${staging}" "${debPath}"`)
  execSync(`rm -rf "${staging}"`)

  console.log(`Created: ${debPath}`)
}

// ── Windows ──

function makeWindows() {
  const nsisDir = ensureNsis()
  const nsiPath = join(outDir, 'installer.nsi')
  const setupExe = join(makeDir, `${APP_NAME}Setup-${VERSION}.exe`)

  writeFileSync(nsiPath, generateNsiScript(setupExe))
  console.log(`Creating installer: ${setupExe}`)

  // Find makensis binary for current platform
  let makensis
  if (process.platform === 'win32') {
    makensis = join(nsisDir, 'windows', 'makensis.exe')
  } else if (process.platform === 'darwin') {
    makensis = join(nsisDir, 'mac', process.arch, 'makensis')
  } else {
    makensis = join(nsisDir, 'linux', 'makensis')
  }
  chmodSync(makensis, 0o755)

  execSync(`"${makensis}" -NOCD "${nsiPath}"`, {
    stdio: 'inherit',
    env: { ...process.env, NSISDIR: join(nsisDir, 'windows') },
  })

  rmSync(nsiPath)
  console.log(`Created: ${setupExe}`)
}

function ensureNsis() {
  const nsisDir = join(root, 'vendor', 'nsis')
  if (existsSync(join(nsisDir, 'windows', 'makensis.exe'))) return nsisDir

  console.log('Downloading NSIS tools...')
  mkdirSync(nsisDir, { recursive: true })

  const tarball = join(outDir, 'nsis.tar.gz')
  execSync(`curl -fSL -o "${tarball}" "https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis%401.0.0/nsis-bundle-3.11.tar.gz"`)
  execSync(`tar -xzf "${tarball}" -C "${nsisDir}" --strip-components=1`)
  rmSync(tarball)

  return nsisDir
}

function generateNsiScript(setupExe) {
  // Use forward slashes for NSIS paths on all platforms
  const outFile = setupExe.replace(/\\/g, '/')
  const appDir = platformOutDir.replace(/\\/g, '/')
  const iconPath = join(root, 'icons', 'icon.ico').replace(/\\/g, '/')

  return `
!include "MUI2.nsh"
!include "nsDialogs.nsh"

Name "${APP_NAME}"
OutFile "${outFile}"
InstallDir "$LOCALAPPDATA\\${APP_NAME}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "${iconPath}"
UninstallIcon "${iconPath}"

!define MUI_ICON "${iconPath}"
!define MUI_UNICON "${iconPath}"

; Skip pages in silent mode
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; Close running instance
  nsExec::ExecToLog 'taskkill /F /IM "${APP_NAME}.exe"'
  Sleep 1000

  SetOutPath $INSTDIR
  File /r "${appDir}\\*.*"

  ; Shortcuts
  CreateDirectory "$SMPROGRAMS\\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\\${APP_NAME}\\${APP_NAME}.lnk" "$INSTDIR\\${APP_NAME}.exe"
  CreateShortcut "$DESKTOP\\${APP_NAME}.lnk" "$INSTDIR\\${APP_NAME}.exe"

  ; Uninstaller
  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  ; Add/Remove Programs entry
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}" "DisplayIcon" "$INSTDIR\\${APP_NAME}.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}" "Publisher" "${pkg.author?.name || ''}"

  ; Relaunch after silent install
  IfSilent 0 +2
    Exec "$INSTDIR\\${APP_NAME}.exe"
SectionEnd

Section "Uninstall"
  ; Close running instance before uninstall
  nsExec::ExecToLog 'taskkill /F /IM "${APP_NAME}.exe"'
  Sleep 1000

  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\\${APP_NAME}"
  Delete "$DESKTOP\\${APP_NAME}.lnk"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}"
SectionEnd
`
}
