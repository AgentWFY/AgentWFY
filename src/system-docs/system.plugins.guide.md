# system.plugins.guide

Plugins add new functions to the execJs runtime and views. They are installed, enabled/disabled, and uninstalled through the command palette.

## Managing Plugins

Open the command palette and select **Plugins...** to:

- **Install** — Select "Install Plugin..." and pick a `.plugins.awfy` package file. The package is validated before installation.
- **Enable / Disable** — Select a plugin, then choose "Enable" or "Disable".
- **Uninstall** — Select a plugin, then choose "Uninstall" to remove it and its docs.

Restart the app after installing, uninstalling, or toggling plugins for changes to take effect.

## Using Plugin Functions

Once a plugin is installed and enabled, its functions are available as top-level globals in execJs — call them the same way you call built-in functions like `read()` or `runSql()`.

```js
// If a plugin registers 'ffmpegRun':
const result = await ffmpegRun({ args: ['-i', 'input.mp4', 'output.webm'] })
```

Load `plugin.<name>` docs for each plugin's function reference:

```js
const rows = await runSql({ target: 'agent', sql: "SELECT content FROM docs WHERE name = ?", params: ['plugin.ffmpeg'] })
```

## Querying Installed Plugins

```js
const plugins = await runSql({ target: 'agent', sql: "SELECT name, description, version, enabled FROM plugins" })
```

The `plugins` table is read-only — use the command palette for management.

## Programmatic Install & Toggle

Views, tasks, and execJs can request plugin installation or toggling. Both methods open a confirmation dialog in the command palette — the user must confirm before the action is performed.

- `requestInstallPlugin(packagePath)` → `{ installed: string[] }` — validates the package, shows plugin info in a confirmation screen, installs on confirm. Returns an empty array if the user cancels.
- `requestTogglePlugin(pluginName)` → `{ toggled: boolean, enabled?: boolean }` — looks up the plugin, shows a confirmation screen, toggles on confirm. Returns `{ toggled: false }` if cancelled.
- `requestUninstallPlugin(pluginName)` → `{ uninstalled: boolean }` — shows a confirmation screen before removing the plugin and its docs. Returns `{ uninstalled: false }` if cancelled.

```js
// Install a plugin package from a known path
const result = await requestInstallPlugin('.tmp/my-plugin.plugins.awfy')
console.log(result.installed) // ['my-plugin'] or []

// Toggle a plugin off
const toggle = await requestTogglePlugin('my-plugin')
console.log(toggle) // { toggled: true, enabled: false } or { toggled: false }

// Uninstall a plugin
const removed = await requestUninstallPlugin('my-plugin')
console.log(removed) // { uninstalled: true } or { uninstalled: false }
```
