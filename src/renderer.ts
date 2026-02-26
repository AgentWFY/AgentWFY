/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/application-architecture#main-and-renderer-processes
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.ts` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

async function getDir() {
  const tools = window.electronClientTools;
  if (!tools || typeof tools.openDialog !== 'function') {
    throw new Error('electronClientTools.openDialog is unavailable');
  }
  const paths = await tools.openDialog({ properties: ['openDirectory'] });
  return paths[0];
}

document.getElementById('openDir').addEventListener('click', async () => {
  const path = await getDir();
  const tools = window.electronClientTools;
  if (tools && typeof tools.setStoreItem === 'function') {
    await tools.setStoreItem('dataDir', path);
  }
  window.close()
});

document.getElementById('cancel').addEventListener('click', async () => {
  window.close()
});
