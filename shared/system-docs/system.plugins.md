# system.plugins

Plugins add new functions to the execJs runtime and views. Plugin functions appear as flat top-level globals, indistinguishable from built-ins.

Plugins are stored in the `plugins` table in agent.db and distributed as `.plugins.awfy` package files. The `plugins` table is read-only — managed through the command palette.

## Installed plugins

Query the `plugins` table to see what's installed:

```js
const plugins = await runSql({ sql: "SELECT name, description, enabled FROM plugins" })
```

Each plugin may provide docs at `plugin.<name>`. Load them on demand:

```js
const content = await read({ path: '@docs/plugin.ffmpeg' })
```

## Reference sections

- `system.plugins.guide` — how to install, manage, and use plugins via the command palette
- `system.plugins.dev` — plugin development: code format, packaging, API reference
