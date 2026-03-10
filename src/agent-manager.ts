import { app, dialog, type BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { mkdir } from 'fs/promises';
import { ensureViewsSchema } from './db/views.js';

const AGENT_DIR_NAME = '.agentwfy';
const MAX_RECENT_AGENTS = 10;

// --- In-memory agent root ---

let currentAgentRoot: string | null = null;

export function getAgentRoot(): string {
  if (!currentAgentRoot) {
    throw new Error('No agent is currently open');
  }
  return currentAgentRoot;
}

export function getCurrentAgentRoot(): string | null {
  return currentAgentRoot;
}

// --- Change listeners ---

type AgentRootChangeListener = (newRoot: string, oldRoot: string | null) => void;
const agentRootChangeListeners: AgentRootChangeListener[] = [];

export function onAgentRootChanged(listener: AgentRootChangeListener): void {
  agentRootChangeListeners.push(listener);
}

// --- Agent dir helpers ---

export function getAgentDir(agentRoot: string): string {
  return path.join(agentRoot, AGENT_DIR_NAME);
}

export async function ensureAgentDir(agentRoot: string): Promise<void> {
  const agentDir = getAgentDir(agentRoot);
  try {
    await mkdir(agentDir, { recursive: true });
  } catch (error) {
    console.error(`[agent-runtime] failed to ensure private agent directory at ${agentDir}`, error);
  }
}

export async function ensureAgentRuntimeBootstrap(agentRoot: string): Promise<void> {
  await ensureAgentDir(agentRoot);
  try {
    await ensureViewsSchema(agentRoot);
  } catch (error) {
    console.error(`[agent-runtime] failed to initialize views schema for ${agentRoot}`, error);
  }
}

function getRecentAgentsPath(): string {
  return path.join(app.getPath('userData'), 'recent-agents.json');
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
}

export function openAgent(dirPath: string): void {
  const oldRoot = currentAgentRoot;
  currentAgentRoot = dirPath;
  addToRecentAgents(dirPath);
  if (oldRoot !== dirPath) {
    for (const listener of agentRootChangeListeners) {
      listener(dirPath, oldRoot);
    }
  }
}

export interface RecentAgent {
  path: string;
  openedAt: number;
}

export function getRecentAgents(): RecentAgent[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(getRecentAgentsPath(), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addToRecentAgents(dirPath: string): void {
  const recents = getRecentAgents().filter(r => r.path !== dirPath);
  recents.unshift({ path: dirPath, openedAt: Date.now() });
  fs.writeFileSync(getRecentAgentsPath(), JSON.stringify(recents.slice(0, MAX_RECENT_AGENTS), null, 2));
}

export function shortenPath(fullPath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

// --- Dialog helpers ---

async function showOpenDialog(parentWindow: BrowserWindow | null, options: Electron.OpenDialogOptions) {
  return parentWindow
    ? dialog.showOpenDialog(parentWindow, options)
    : dialog.showOpenDialog(options);
}

async function showMessageBox(parentWindow: BrowserWindow | null, options: Electron.MessageBoxOptions) {
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options);
}

// --- Public dialog flows ---

/**
 * Prompt user to choose between default install or from .awfy file.
 * Returns the agentRoot path on success, or null on cancel.
 */
async function promptInstallChoice(dirPath: string, parentWindow: BrowserWindow | null): Promise<string | null> {
  const result = await showMessageBox(parentWindow, {
    type: 'question',
    title: 'Install Agent',
    message: `Install agent in "${path.basename(dirPath)}"?`,
    detail: 'Choose how to initialize:',
    buttons: ['Default Agent', 'From File (.awfy)', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });

  if (result.response === 2) return null;

  if (result.response === 0) {
    await initAgent(dirPath);
    return dirPath;
  }

  // From file
  const fileResult = await showOpenDialog(parentWindow, {
    properties: ['openFile'],
    title: 'Select Agent File',
    filters: [{ name: 'Agent Files', extensions: ['awfy'] }],
  });
  if (fileResult.canceled || fileResult.filePaths.length === 0) return null;

  await initAgent(dirPath, fileResult.filePaths[0]);
  return dirPath;
}

/**
 * Open Agent flow: pick a directory, check for .agentwfy, ask user if missing.
 */
export async function showOpenAgentDialog(parentWindow: BrowserWindow | null = null): Promise<string | null> {
  const result = await showOpenDialog(parentWindow, {
    properties: ['openDirectory'],
    title: 'Open Agent',
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const dirPath = result.filePaths[0];

  if (isAgentDir(dirPath)) return dirPath;

  const msgResult = await showMessageBox(parentWindow, {
    type: 'question',
    title: 'No Agent Found',
    message: `"${path.basename(dirPath)}" does not contain an agent.`,
    detail: 'Would you like to install an agent in this directory?',
    buttons: ['Install Agent', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });

  if (msgResult.response === 1) return null;

  return promptInstallChoice(dirPath, parentWindow);
}

/**
 * Install Agent flow: pick a directory, install agent in it.
 */
export async function showInstallAgentDialog(parentWindow: BrowserWindow | null = null): Promise<string | null> {
  const result = await showOpenDialog(parentWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose Directory for Agent',
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const dirPath = result.filePaths[0];

  if (isAgentDir(dirPath)) {
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

  return promptInstallChoice(dirPath, parentWindow);
}

/**
 * First-launch dialog when no agent is open.
 * Returns the picked agentRoot path, or null to quit.
 */
export async function showAgentPickerDialog(): Promise<string | null> {
  const recents = getRecentAgents();

  if (recents.length > 0) {
    // Show recents as additional buttons
    const recentLabels = recents.slice(0, 3).map(r => shortenPath(r.path));
    const buttons = ['Open Agent...', 'Install Agent...', ...recentLabels, 'Quit'];

    const result = await dialog.showMessageBox({
      type: 'question',
      title: 'Welcome to AgentWFY',
      message: 'No agent is currently open.',
      detail: 'Open an existing agent or install a new one.',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });

    const idx = result.response;
    if (idx === buttons.length - 1) return null; // Quit
    if (idx === 0) return showOpenAgentDialog();
    if (idx === 1) return showInstallAgentDialog();

    // Recent agent selected
    const recentIdx = idx - 2;
    if (recentIdx >= 0 && recentIdx < recents.length) {
      const recentPath = recents[recentIdx].path;
      if (isAgentDir(recentPath)) return recentPath;
      // Recent agent no longer exists — fall through to open dialog
      return showOpenAgentDialog();
    }

    return null;
  }

  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Welcome to AgentWFY',
    message: 'No agent is currently open.',
    detail: 'Open an existing agent directory or install a new one.',
    buttons: ['Open Agent...', 'Install Agent...', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  });

  if (result.response === 2) return null;
  if (result.response === 0) return showOpenAgentDialog();
  if (result.response === 1) return showInstallAgentDialog();

  return null;
}
