# Echo Plugin

A minimal AgentWFY plugin that echoes input back. Use it as a starting point for your own plugins or to verify that the plugin system works.

## Functions

- **`echoTest(params)`** — returns `{ echoed: params, timestamp }`.
- **`echoRepeat({ text, count? })`** — repeats `text` the given number of times (default 3).

## Project Structure

```
echo/
├── src/
│   └── index.js      # Plugin source — exports activate(api)
├── docs/
│   └── plugin.echo.md  # Docs bundled into the package (loaded by the agent)
├── build.mjs          # Build script → dist/echo.plugins.awfy
├── package.json
└── README.md
```

## Developing

Edit `src/index.js` to add or change functions. Use `api.registerFunction(name, handler)` to expose them.

Edit docs in `docs/` — files are named `plugin.<name>.md` (or `plugin.<name>.<section>.md` for sub-sections). They are bundled into the package and become available to the agent via `runSql`.

## Building

```sh
npm run build
```

Produces `dist/echo.plugins.awfy`. Install it in AgentWFY via the command palette (**Plugins... → Install Plugin...**).

## Plugin API Reference

The `activate(api)` function receives:

- `api.agentRoot` — absolute path to the agent's data directory.
- `api.assetsDir` — path to `.agentwfy/plugin-assets/<name>/` for runtime files.
- `api.publish(topic, data)` — publish a message to the event bus.
- `api.registerFunction(name, handler)` — register a function. `name` becomes a global in execJs and views.

Handler signature: `async (params) => result`. Runs in the main process with full Node.js access. Return JSON-serializable data only.

Optionally return `{ deactivate() { ... } }` from `activate()` to clean up resources when the window closes.
