import { app, dialog, BaseWindow, net, shell } from 'electron';
import { createWriteStream, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const REPO_OWNER = 'AgentWFY';
const REPO_NAME = 'AgentWFY';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let checkTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoUpdater() {
  // Don't check in dev mode
  if (!app.isPackaged) return;

  // Check after a short delay on startup, then periodically
  setTimeout(() => checkForUpdates(true), 10_000);
  checkTimer = setInterval(() => checkForUpdates(true), CHECK_INTERVAL_MS);
}

export function stopAutoUpdater() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

export async function checkForUpdates(silent = false) {
  try {
    const release = await fetchLatestRelease();
    if (!release) {
      if (!silent) showNoUpdateDialog();
      return;
    }

    const currentVersion = app.getVersion();
    if (!isNewer(release.tag_name, currentVersion)) {
      if (!silent) showNoUpdateDialog();
      return;
    }

    const asset = findAssetForPlatform(release.assets);
    if (!asset) {
      if (!silent) {
        showErrorDialog(`No download available for ${process.platform}-${process.arch}`);
      }
      return;
    }

    await promptAndInstall(release.tag_name, release.body, asset);
  } catch (err) {
    console.error('[auto-updater] Check failed:', err);
    if (!silent) {
      showErrorDialog(`Update check failed: ${(err as Error).message}`);
    }
  }
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  body: string;
  assets: ReleaseAsset[];
}

async function fetchLatestRelease(): Promise<Release | null> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  const response = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);

  return response.json() as Promise<Release>;
}

function isNewer(tagName: string, currentVersion: string): boolean {
  // Strip leading 'v' from tag
  const remote = tagName.replace(/^v/, '');
  const current = currentVersion.replace(/^v/, '');

  const remoteParts = remote.split('.').map(Number);
  const currentParts = current.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const r = remoteParts[i] || 0;
    const c = currentParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

function findAssetForPlatform(assets: ReleaseAsset[]): ReleaseAsset | null {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    // Look for the .zip (used for auto-update), match arch
    return assets.find((a) => a.name.endsWith('-mac.zip') && a.name.includes(arch)) || null;
  }

  if (platform === 'win32') {
    // Look for Setup .exe
    return assets.find((a) => a.name.includes('Setup') && a.name.endsWith('.exe')) || null;
  }

  if (platform === 'linux') {
    // Look for .deb matching arch
    const debArch = arch === 'x64' ? 'amd64' : arch;
    return assets.find((a) => a.name.endsWith('.deb') && a.name.includes(debArch)) || null;
  }

  return null;
}

async function promptAndInstall(version: string, releaseNotes: string, asset: ReleaseAsset) {
  const win = BaseWindow.getFocusedWindow() ?? BaseWindow.getAllWindows()[0];

  const { response } = await dialog.showMessageBox({
    ...(win ? { window: win } : {}),
    type: 'info',
    title: 'Update Available',
    message: `A new version (${version.replace(/^v/, '')}) is available.`,
    detail: releaseNotes ? releaseNotes.slice(0, 500) : 'Would you like to download and install it?',
    buttons: ['Install Update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response !== 0) return;

  await downloadAndInstall(asset, win);
}

async function downloadAndInstall(asset: ReleaseAsset, win: BaseWindow | null) {
  const tempDir = join(app.getPath('temp'), 'agentwfy-update');
  mkdirSync(tempDir, { recursive: true });
  const filePath = join(tempDir, asset.name);

  try {
    // Show progress dialog
    if (win) {
      win.setProgressBar(0);
    }

    const response = await net.fetch(asset.browser_download_url);
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);

    const totalSize = asset.size;
    let downloaded = 0;

    const reader = response.body.getReader();
    const writeStream = createWriteStream(filePath);

    const nodeStream = new Readable({
      async read() {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        downloaded += value.byteLength;
        if (win && totalSize > 0) {
          win.setProgressBar(downloaded / totalSize);
        }
        this.push(Buffer.from(value));
      },
    });

    await pipeline(nodeStream, writeStream);

    if (win) win.setProgressBar(-1); // Remove progress bar

    await applyUpdate(filePath);
  } catch (err) {
    if (win) win.setProgressBar(-1);
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

async function applyUpdate(filePath: string) {
  const platform = process.platform;

  if (platform === 'win32') {
    // Run NSIS installer silently, it will close the app, install, and relaunch
    spawn(filePath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return;
  }

  if (platform === 'darwin') {
    // Extract zip and replace current app bundle
    const appPath = app.getAppPath(); // .../AgentWFY.app/Contents/Resources/app
    const appBundle = join(appPath, '..', '..', '..'); // AgentWFY.app
    const appDir = join(appBundle, '..'); // directory containing AgentWFY.app
    const tempExtract = join(app.getPath('temp'), 'agentwfy-update-extract');

    rmSync(tempExtract, { recursive: true, force: true });
    mkdirSync(tempExtract, { recursive: true });

    const { execSync } = await import('child_process');
    // Extract the zip
    execSync(`ditto -x -k "${filePath}" "${tempExtract}"`);

    // Replace the app bundle
    execSync(`rm -rf "${appBundle}"`);
    execSync(`mv "${tempExtract}/AgentWFY.app" "${appDir}/"`);

    rmSync(tempExtract, { recursive: true, force: true });
    rmSync(filePath, { force: true });

    // Relaunch
    app.relaunch();
    app.quit();
    return;
  }

  if (platform === 'linux') {
    // Open the .deb file with the system handler, let user install via package manager
    shell.openPath(filePath);
    return;
  }
}

function showNoUpdateDialog() {
  const win = BaseWindow.getFocusedWindow() ?? undefined;
  dialog.showMessageBox({
    ...(win ? { window: win } : {}),
    type: 'info',
    title: 'No Updates',
    message: 'You are running the latest version.',
    buttons: ['OK'],
  });
}

function showErrorDialog(message: string) {
  const win = BaseWindow.getFocusedWindow() ?? undefined;
  dialog.showMessageBox({
    ...(win ? { window: win } : {}),
    type: 'error',
    title: 'Update Error',
    message,
    buttons: ['OK'],
  });
}
