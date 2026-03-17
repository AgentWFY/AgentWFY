# FFmpeg Plugin

An AgentWFY plugin that spawns ffmpeg processes and streams their output via the event bus. Requires `ffmpeg` installed on the system PATH.

## Functions

- **`ffmpeg({ args })`** — spawn ffmpeg with the given args array. Returns `{ id }`. Output streams via `ffmpeg:{id}:output` and `ffmpeg:{id}:done` event bus topics.
- **`ffmpegKill({ id })`** — send SIGTERM to a running ffmpeg process.

## Project Structure

```
ffmpeg/
├── src/
│   └── index.js         # Plugin source — exports activate(api)
├── docs/
│   └── plugin.ffmpeg.md   # Docs bundled into the package (loaded by the agent)
├── build.mjs             # Build script → dist/ffmpeg.plugins.awfy
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

Produces `dist/ffmpeg.plugins.awfy`. Install it in AgentWFY via the command palette (**Plugins... → Install Plugin...**).

## Plugin API Reference

The `activate(api)` function receives:

- `api.agentRoot` — absolute path to the agent's data directory.
- `api.assetsDir` — path to `.agentwfy/plugin-assets/<name>/` for runtime files.
- `api.publish(topic, data)` — publish a message to the event bus.
- `api.registerFunction(name, handler)` — register a function. `name` becomes a global in execJs and views.

Handler signature: `async (params) => result`. Runs in the main process with full Node.js access. Return JSON-serializable data only.

Optionally return `{ deactivate() { ... } }` from `activate()` to clean up resources when the window closes.
