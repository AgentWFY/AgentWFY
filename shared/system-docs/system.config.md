# system.config

App settings are stored in the `config` table. Each setting can be set at agent level (in the DB) or globally (in `~/.agentwfy.json`). The user can manage settings via the command palette.

## Naming Convention

- `system.*` — built-in system settings, synced on startup
- `plugin.*` — plugin settings, installed/uninstalled with plugins
- Other names — user-defined settings

Config names must match `[a-z0-9._-]+` (enforced by the database).

System and plugin config rows cannot be inserted or deleted by the agent, but their `value` can be updated.

## Resolution Order

When a setting is read, the app resolves it in this order:

1. **Agent DB** — per-agent override (non-NULL value)
2. **Global config** (`~/.agentwfy.json`) — user-wide defaults shared across all instances
3. **Consumer fallback** — hardcoded default in the code

If `~/.agentwfy.json` does not exist, the app falls back to reading from the internal Electron store (`userData/config.json`).

Set `value = NULL` to revert a setting to the global/default.

All values are stored as strings in the agent DB — no JSON encoding. Numbers and booleans are their string form (e.g. `'8080'`, `'true'`). The global config file uses standard JSON types.

## Shortcuts

Shortcut bindings live in the same table:
- `system.shortcuts.<action-id>` — built-in actions (read-only namespace; values are user-editable).
- `shortcuts.task.<task-name>` — runs the task with that name. Agent CRUD is allowed (no `system.*` guard).

Values are key combos like `mod+shift+r` (mod = Cmd on macOS, Ctrl elsewhere) or `'disabled'` to unbind.
