/** Daemon-side built-in runtime function names — what registerAllBuiltInFunctions
 *  (in ./functions/index.ts) registers, plus daemon-owned functions registered
 *  by the remote server bootstrap. Client-side-only functions such as
 *  pickFromPalette/openExternal live in CLIENT_RUNTIME_FUNCTIONS and are added
 *  by the connected client's function registry.
 *
 *  Surfaced to remote-agent views via the preload bridge so `window.agentwfy.X`
 *  works without an async list() round-trip. Calls fail with the underlying
 *  WS-disconnect error if invoked while the daemon is offline (except runSql,
 *  which RemoteBackend.functions.invoke routes to the local DB mirror).
 *
 *  Keep in sync with registerAllBuiltInFunctions. Adding a new built-in?
 *  Add its name here. */
export const DAEMON_BUILT_IN_FUNCTIONS = [
  'runSql',
  'read',
  'write',
  'edit',
  'ls',
  'mkdir',
  'remove',
  'rename',
  'find',
  'grep',
  'getPages',
  'openPage',
  'openClientPage',
  'closePage',
  'reloadPage',
  'getCurrentClientPage',
  'capturePage',
  'getPageConsoleLogs',
  'runPageJs',
  'sendPageInput',
  'inspectPageElement',
  'sendPageCdp',
  'subscribePageCdp',
  'detachPageCdp',
  'publish',
  'waitFor',
  'spawnSession',
  'sendToSession',
  'openSessionInChat',
  'listSessions',
  'searchSessions',
  'readSession',
  'startTask',
  'stopTask',
  'listTaskRuns',
  'searchTaskRuns',
  'readTaskRun',
  'getAvailableFunctions',
  'getAvailableProviders',
  'requestInstallPlugin',
  'requestInstallPluginFromBytes',
  'requestInstallPluginFromUrl',
  'requestTogglePlugin',
  'requestUninstallPlugin',
] as const
