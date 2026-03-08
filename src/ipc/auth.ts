import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { assertPathAllowed } from '../security/path-policy.js';
import { Channels } from './channels.js';

export function registerAuthHandlers(getRoot: () => string) {
  const resolvePrivatePath = (relativePath: string, options?: { allowMissing?: boolean }) =>
    assertPathAllowed(getRoot(), relativePath, { ...options, allowAgentPrivate: true });
  const resolveAuthConfigPath = (options?: { allowMissing?: boolean }) =>
    resolvePrivatePath('.agentwfy/config/auth.json', options);
  const resolveLegacyApiKeyPath = () =>
    resolvePrivatePath('.agentwfy/config/api_key');

  // readAuthConfig() → auth config json string
  ipcMain.handle(Channels.auth.readConfig, async () => {
    const authConfigPath = await resolveAuthConfigPath();
    return fs.readFile(authConfigPath, 'utf-8');
  });

  // writeAuthConfig(content)
  ipcMain.handle(Channels.auth.writeConfig, async (_event, content: string) => {
    const authConfigPath = await resolveAuthConfigPath({ allowMissing: true });
    await fs.mkdir(path.dirname(authConfigPath), { recursive: true });
    await fs.writeFile(authConfigPath, content, 'utf-8');
  });

  // readLegacyApiKey() → legacy api key string
  ipcMain.handle(Channels.auth.readLegacyKey, async () => {
    const legacyApiKeyPath = await resolveLegacyApiKeyPath();
    return fs.readFile(legacyApiKeyPath, 'utf-8');
  });
}
