import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

// macOS delivers user notifications through UNUserNotificationCenter, which
// refuses to register a bundle whose signature doesn't seal Info.plist —
// `new Notification().show()` then fails with `UNErrorDomain error 1`
// (notificationsNotAllowed). Upstream Electron zips ship linker-signed only
// (no Contents/_CodeSignature), and packaging rewrites Info.plist anyway, so
// both the vendored Electron and the packaged app need an ad-hoc re-sign.
export function adhocSign(appBundle) {
  execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'pipe' })
}

/** True when the bundle carries a sealed signature (not just a linker-signed binary). */
export function isBundleSigned(appBundle) {
  return existsSync(join(appBundle, 'Contents', '_CodeSignature'))
}
