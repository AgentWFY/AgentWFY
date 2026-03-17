# system.plugins.dev

Plugin development guide. Plugins extend the agent runtime with new functions backed by Node.js code running in the main process.

## Plugin Code

Export an `activate` function that receives a `PluginApi` object. Use `api.registerFunction()` to expose functions to the agent runtime. Plugin functions appear as flat top-level globals in execJs and view runtimes, indistinguishable from built-ins.

```js
module.exports = {
  activate(api) {
    const root = api.agentRoot
    const assets = api.assetsDir

    api.registerFunction('myPluginDo', async (params) => {
      // params — whatever the agent passes when calling myPluginDo(params)
      // root, assets — captured during activation
      // api.publish(topic, data) — post to the event bus
      return { result: 'done' }
    })
  }
}
```

### Deactivation

`activate()` can optionally return `{ deactivate }`. Called when the window closes — use it to clean up long-running resources (child processes, timers, connections).

```js
module.exports = {
  activate(api) {
    const processes = new Map()

    api.registerFunction('start', async (params) => {
      const child = spawn(...)
      processes.set(child.pid, child)
      return { pid: child.pid }
    })

    return {
      deactivate() {
        for (const child of processes.values()) child.kill('SIGTERM')
        processes.clear()
      }
    }
  }
}
```

### api object

- `api.agentRoot` — absolute path to the agent's data directory.
- `api.assetsDir` — path to `.agentwfy/plugin-assets/<name>/` for runtime files (binaries, caches).
- `api.publish(topic, data)` — publish a message to the event bus.
- `api.registerFunction(name, handler)` — register a function. `name` becomes the global function name in execJs / views.

### handler signature

```
handler(params: unknown) → Promise<unknown>
```

- `params` — the argument the agent passes when calling the function.

The handler runs in the main process with full Node.js access (child_process, fs, net, etc.). Return values are serialized back to the worker/view via IPC — return JSON-serializable data only.

### Naming rules

- Function names must not collide with built-in runtime functions (`runSql`, `read`, `write`, `openTab`, `fetch`, etc.) or functions from other plugins. Collisions are logged as warnings and the function is skipped.
- Use a plugin-specific prefix to avoid collisions: `myPluginDo`, `myPluginQuery`, etc.

## Plugin Package Format

Plugins are distributed as `.plugins.awfy` files with three tables:

```sql
plugins (name TEXT, description TEXT, version TEXT, code TEXT)  — 1..N rows
docs    (name TEXT, content TEXT)                                — 0..N rows
assets  (name TEXT, data BLOB)                                  — 0..N rows
```

A package can contain one or multiple plugins (plugin pack).

### Naming conventions

- **docs**: must start with `plugin.<name>` where `<name>` matches a plugin in the `plugins` table. Example: `plugin.ffmpeg`, `plugin.ffmpeg.usage`.
- **assets**: must use `<name>/<filename>` format. Example: `ffmpeg/ffmpeg-darwin-arm64`. Extracted to `.agentwfy/plugin-assets/<name>/<filename>` on install.

## Plugin Docs

Include docs in the package's `docs` table. They are synced to agent.db on install:

- `plugin.<name>` — main doc for the plugin
- `plugin.<name>.<section>` — additional sections

Plugin docs are read-only from the agent's perspective. The `system.plugins` doc auto-lists all installed plugins and tells the agent to load `plugin.<name>` for details. Use docs to document function signatures, parameters, return values, and usage examples so the agent knows how to call your functions.

## Example: Echo Plugin

Plugin code (stored in `plugins.code`):
```js
module.exports = {
  activate(api) {
    api.registerFunction('echoTest', async params => {
      return { echoed: params }
    })
  }
}
```

Package `.plugins.awfy` contents:
```sql
INSERT INTO plugins VALUES ('echo', 'Echo test plugin', '1.0.0', '<code above>');
INSERT INTO docs VALUES ('plugin.echo', '# plugin.echo\n\n## echoTest(params)\n\nReturns { echoed: params }.');
```

## Error Handling

- If plugin code fails to eval or doesn't export `activate`, the plugin is skipped with a warning.
- If a function handler throws, the error is propagated as a rejected promise to the caller — the app does not crash.
- Package validation rejects invalid packages entirely — no partial installs.

## Database

The `plugins` table:

```sql
plugins (id, name UNIQUE, description, version, code TEXT, enabled, created_at, updated_at)
```

This table is read-only from SQL — the agent can query it but cannot modify it.
