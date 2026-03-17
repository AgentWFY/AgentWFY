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
