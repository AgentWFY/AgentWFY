# Plan: Centralize `system.*` config keys

## Goal

Replace raw `'system.*'` string literals across the codebase with named constants from a single shared module. Both the main process (Node) and the renderer (browser) currently hardcode the same key strings independently — typos, renames, and key-drift silently slip through.

## Single source of truth

`src/system-config/system-config.json` already enumerates every key. Make it the build-time source of the constants module so adding a new key means editing one file.

## Proposed file: `src/system-config/keys.ts`

A pure-TS module — **no Node-only imports** (so the renderer can import it directly). It exports:

1. `SystemConfigKey` — string-literal union of every `name` from `system-config.json`.
2. `SystemConfigKeys` — a `const` object mapping camelCased identifiers (e.g. `hideTrafficLights`) to the raw string (`'system.hide-traffic-lights'`). Use `as const` so consumers get narrow literal types.
3. `SYSTEM_PREFIX = 'system.'` and `PLUGIN_PREFIX = 'plugin.'` for the many `name.startsWith('system.')` / `LIKE 'system.%'` checks.
4. `SHORTCUT_PREFIX = 'system.shortcuts.'` (replaces `SHORTCUT_CONFIG_PREFIX` in `src/shortcuts/actions.ts:36`).
5. `OPENAI_COMPATIBLE_PREFIX = 'system.openai-compatible-provider'` (replaces the local `CONFIG_PREFIX` in `src/providers/openai_compatible.ts:715`).

### Two implementation options for the keys themselves

**Option A — generated:** add a build step in `scripts/build` that reads `system-config.json` and writes `dist/system-config-keys.json` plus emits `src/system-config/keys.ts` (or a `.d.ts`) at build time. Pro: cannot drift. Con: adds codegen complexity; `keys.ts` becomes a build artifact.

**Option B — hand-maintained, validated at runtime:** write `keys.ts` by hand. Add a tiny check at app startup (or in a unit-style assertion in `src/db/agent-db.ts` where the JSON is already parsed) that verifies every key in `system-config.json` exists in `SystemConfigKeys` and vice versa, throwing on mismatch. Pro: simpler; one file to edit when adding a key. Con: relies on the assertion to catch drift.

**Recommend Option B** unless you already have other codegen infrastructure — the assertion catches mistakes during dev startup, which is fast enough.

## Files to update

### Main process (Node)
| File | Lines | Change |
|---|---|---|
| `src/main.ts` | 132–134 | `'system.theme'`, `'system.show-tab-source'`, `'system.hide-traffic-lights'` → constants |
| `src/main.ts` | 249 | `'system.default-view'` → constant |
| `src/agent-context-factory.ts` | 155 | `'system.http-api.port'` → constant |
| `src/cleanup.ts` | 119–121 | three `system.cleanup.*` keys → constants |
| `src/agent-orchestrator.ts` | 320, 323, 326 | `'system.show-tab-source'`, `'system.hide-traffic-lights'`, `'system.provider'` → constants |
| `src/agent-orchestrator.ts` | 409 | `'system.default-view'` → constant |
| `src/window-manager.ts` | 39–40, 46–47, 350–351 | three keys → constants |
| `src/backup.ts` | 41, 45 | two `system.backup.*` keys → constants |
| `src/agent/session_manager.ts` | 429 | `'system.provider'` in raw SQL — leave as-is OR template the SQL with the constant; raw SQL strings inside the constant make this awkward, so probably leave with a comment |
| `src/plugins/registry.ts` | 187, 189 | `'system.provider'` → constant |
| `src/providers/openai_compatible.ts` | 715 | replace local `CONFIG_PREFIX` with imported `OPENAI_COMPATIBLE_PREFIX` |
| `src/ipc/providers.ts` | 14, 42 | `'system.provider'` → constant |
| `src/shortcuts/actions.ts` | 36 | replace `SHORTCUT_CONFIG_PREFIX` with re-export from `keys.ts`, OR delete and update consumers |
| `src/default-agent.ts` | 169, 180 | `'system.shortcuts.' + id` — switch to `SHORTCUT_PREFIX + id` from `keys.ts` |
| `src/command-palette/manager.ts` | 269, 386, 434 | `'system.'` / `'plugin.'` prefix checks → use `SYSTEM_PREFIX` / `PLUGIN_PREFIX` |

### Renderer
| File | Lines | Change |
|---|---|---|
| `src/renderer/components/app.ts` | 9–12 | delete the four local `HIDE_*_KEY` constants; import the equivalents from `keys.ts` |
| `src/renderer/components/tabs.ts` | 102, 126, 138 | `'system.show-tab-source'` → constant |
| `src/renderer/components/provider_grid.ts` | 168 | `'system.plugins'` is a *view name*, not a config key — leave alone unless a separate "system view names" constants file is also wanted |

### Intentionally skip

These are not config-key references and shouldn't be touched:

- `src/db/agent-db.ts` SQL trigger bodies (lines 13, 23, 140, 142, 146, 149, 153, 155, 185, 187, 191, 193, 273, 282, 291) — these are SQL string literals that need the prefix at the SQL level. Could template them with `${SYSTEM_PREFIX}` but the SQL is multi-line and the escaping/clarity tradeoff is poor. Leave as-is.
- `src/db/views.ts` (75, 76) and `src/db/config.ts` (14, 15) — same reason, SQL `LIKE` patterns.
- `src/system-config/system-config.json` itself — this is the source of truth.

## Suggested working order

1. Create `src/system-config/keys.ts` with the union, the `SystemConfigKeys` const object, and the prefix constants. Pull every name from `system-config.json` (current count: ~37 keys).
2. Add the runtime drift assertion in `src/db/agent-db.ts` (or wherever `system-config.json` is first parsed at startup) so missing/extra keys fail the build/start.
3. Migrate **main-process** files first (table above). Run `./scripts/build` after each batch — tsgo will catch typos and unused imports.
4. Migrate **renderer** files. The renderer cannot import Node-only modules; verify `keys.ts` stays pure (no `fs`, `path`, etc.).
5. Replace the existing local helpers (`SHORTCUT_CONFIG_PREFIX`, the providers' `CONFIG_PREFIX`, the renderer's `HIDE_*_KEY`s).
6. Final build + a smoke test: launch the app, change `system.theme` in the command palette, change `system.hide-traffic-lights`, switch agents — verify nothing broke.

## Acceptance criteria

- `grep -rn "'system\." src --include="*.ts" --include="*.cts"` returns only:
  - SQL strings inside `src/db/agent-db.ts`, `src/db/views.ts`, `src/db/config.ts` (intentionally skipped).
  - The `keys.ts` definitions themselves.
- The runtime assertion fires on a deliberate mismatch (test by adding a stray key to either side and confirming startup fails with a clear error).
- `./scripts/build` passes.
- App launches; theme switching, agent switching, hide-* settings, shortcuts, providers all still work.

## Out of scope

- Renaming any of the existing keys.
- Restructuring the `AgentOrchestratorDeps` interface (the separate review mentioned collapsing `applyTheme` / `applyTrafficLight*` into one `applyWindowChrome()` callback — that's a different cleanup).
- Adding a batch `getSettings(keys)` IPC.
- Touching `'plugin.*'` keys beyond the bare prefix constant — they're dynamic and don't belong in the static keys list.
