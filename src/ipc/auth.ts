import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { assertPathAllowed } from '../security/path-policy.js';
import { Channels } from './channels.js';

export function registerAuthHandlers(getRoot: (e: IpcMainInvokeEvent) => string) {
  const resolvePrivatePath = (event: IpcMainInvokeEvent, relativePath: string, options?: { allowMissing?: boolean }) =>
    assertPathAllowed(getRoot(event), relativePath, { ...options, allowAgentPrivate: true });
  const resolveAuthConfigPath = (event: IpcMainInvokeEvent, options?: { allowMissing?: boolean }) =>
    resolvePrivatePath(event, '.agentwfy/config/auth.json', options);
  const resolveLegacyApiKeyPath = (event: IpcMainInvokeEvent) =>
    resolvePrivatePath(event, '.agentwfy/config/api_key');

  // readAuthConfig() → auth config json string
  ipcMain.handle(Channels.auth.readConfig, async (event) => {
    const authConfigPath = await resolveAuthConfigPath(event);
    return fs.readFile(authConfigPath, 'utf-8');
  });

  // writeAuthConfig(content)
  ipcMain.handle(Channels.auth.writeConfig, async (event, content: string) => {
    const authConfigPath = await resolveAuthConfigPath(event, { allowMissing: true });
    await fs.mkdir(path.dirname(authConfigPath), { recursive: true });
    await fs.writeFile(authConfigPath, content, 'utf-8');
  });

  // readLegacyApiKey() → legacy api key string
  ipcMain.handle(Channels.auth.readLegacyKey, async (event) => {
    const legacyApiKeyPath = await resolveLegacyApiKeyPath(event);
    return fs.readFile(legacyApiKeyPath, 'utf-8');
  });
}
