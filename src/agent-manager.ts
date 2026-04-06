import { app, dialog, type BaseWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { mkdir } from 'fs/promises';
import { ensureViewsSchema } from './db/views.js';
import { seedDefaultAgent } from './default-agent.js';

const AGENT_DIR_NAME = '.agentwfy';
const DEFAULT_AGENTS_DIR = 'agents';
const DEFAULT_AGENT_BASE_NAME = 'Default Agent';

// --- Agent dir helpers ---

export function getAgentDir(agentRoot: string): string {
  return path.join(agentRoot, AGENT_DIR_NAME);
}

async function ensureAgentDir(agentRoot: string): Promise<void> {
  const agentDir = getAgentDir(agentRoot);
  await mkdir(agentDir, { recursive: true });
}

export async function ensureAgentRuntimeBootstrap(agentRoot: string): Promise<void> {
  await ensureAgentDir(agentRoot);
  await ensureViewsSchema(agentRoot);
}

export function isAgentDir(dirPath: string): boolean {
  try {
    return fs.statSync(path.join(dirPath, AGENT_DIR_NAME)).isDirectory();
  } catch {
    return false;
  }
}

export async function initAgent(dirPath: string, sourceDbPath?: string): Promise<void> {
  if (sourceDbPath) {
    const agentDir = path.join(dirPath, AGENT_DIR_NAME);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.copyFileSync(sourceDbPath, path.join(agentDir, 'agent.db'));
  }
  await ensureAgentRuntimeBootstrap(dirPath);
  if (!sourceDbPath) {
    await seedDefaultAgent(dirPath);
  }
}

// --- Dialog helpers ---

async function showOpenDialog(parentWindow: BaseWindow | null, options: Electron.OpenDialogOptions) {
  return parentWindow
    ? dialog.showOpenDialog(parentWindow, options)
    : dialog.showOpenDialog(options);
}

async function showMessageBox(parentWindow: BaseWindow | null, options: Electron.MessageBoxOptions) {
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options);
}

// --- Public dialog flows ---

/**
 * Add Agent flow: pick a directory, check for .agentwfy, offer to install default if missing.
 */
export async function showOpenAgentDialog(parentWindow: BaseWindow | null = null): Promise<string | null> {
  const result = await showOpenDialog(parentWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Add Agent',
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const dirPath = result.filePaths[0];

  if (isAgentDir(dirPath)) return dirPath;

  const msgResult = await showMessageBox(parentWindow, {
    type: 'question',
    title: 'No Agent Found',
    message: `"${path.basename(dirPath)}" does not contain an agent.`,
    detail: 'Would you like to install a default agent in this directory?',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });

  if (msgResult.response === 1) return null;

  await initAgent(dirPath);
  return dirPath;
}

async function promptOpenExistingAgent(dirPath: string, parentWindow: BaseWindow | null): Promise<string | null> {
  const msgResult = await showMessageBox(parentWindow, {
    type: 'question',
    title: 'Agent Already Exists',
    message: `"${path.basename(dirPath)}" already contains an agent.`,
    detail: 'Would you like to open it instead?',
    buttons: ['Open Agent', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (msgResult.response === 1) return null;
  return dirPath;
}

/**
 * Install Agent flow: pick a directory, install default agent directly.
 */
export async function showInstallAgentDialog(parentWindow: BaseWindow | null = null): Promise<string | null> {
  const result = await showOpenDialog(parentWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose Directory for Agent',
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const dirPath = result.filePaths[0];

  if (isAgentDir(dirPath)) return promptOpenExistingAgent(dirPath, parentWindow);

  await initAgent(dirPath);
  return dirPath;
}

/**
 * Install Agent from File flow: pick a directory, then pick a .agent.awfy file.
 */
export async function showInstallAgentFromFileDialog(parentWindow: BaseWindow | null = null): Promise<string | null> {
  const dirResult = await showOpenDialog(parentWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose Directory for Agent',
  });
  if (dirResult.canceled || dirResult.filePaths.length === 0) return null;

  const dirPath = dirResult.filePaths[0];

  if (isAgentDir(dirPath)) return promptOpenExistingAgent(dirPath, parentWindow);

  const fileResult = await showOpenDialog(parentWindow, {
    properties: ['openFile'],
    title: 'Select Agent File',
    filters: [{ name: 'Agent Files', extensions: ['agent.awfy'] }],
  });
  if (fileResult.canceled || fileResult.filePaths.length === 0) return null;

  await initAgent(dirPath, fileResult.filePaths[0]);
  return dirPath;
}

// --- Default agent helpers ---

let _defaultAgentsDir: string | undefined;
function getDefaultAgentsDir(): string {
  if (!_defaultAgentsDir) {
    _defaultAgentsDir = path.join(app.getPath('userData'), DEFAULT_AGENTS_DIR);
  }
  return _defaultAgentsDir;
}

export function isDefaultAgentPath(agentRoot: string): boolean {
  return agentRoot.startsWith(getDefaultAgentsDir() + path.sep);
}

/**
 * Create a default agent in the userData/agents/ directory.
 * Names: "Default Agent", "Default Agent 2", "Default Agent 3", etc.
 */
export async function createDefaultAgent(): Promise<string> {
  const baseDir = getDefaultAgentsDir();
  fs.mkdirSync(baseDir, { recursive: true });

  const existing = new Set<string>();
  try {
    for (const name of fs.readdirSync(baseDir)) {
      existing.add(name);
    }
  } catch { /* empty dir */ }

  let name = DEFAULT_AGENT_BASE_NAME;
  let i = 2;
  while (existing.has(name)) {
    name = `${DEFAULT_AGENT_BASE_NAME} ${i}`;
    i++;
  }

  const dirPath = path.join(baseDir, name);
  await initAgent(dirPath);
  return dirPath;
}
