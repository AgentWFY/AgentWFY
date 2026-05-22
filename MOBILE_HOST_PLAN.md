# Mobile host + desktop/mobile split

Splits the current single-host (Electron) layout into:

```
agentwfy/
  shared/                  # platform-neutral core (unchanged)
  remote-backend-server/   # remote daemon (unchanged)
  desktop/                 # was src/  — Electron host
  mobile/                  # already exists — Tauri host
```

Decisions baked in (from the planning conversation):

- Desktop stays Electron. CDP is needed for local desktop agents only; mobile
  agents are always remote, so no CDP on mobile.
- Mobile UI is its own codebase. No Web Component sharing with desktop until
  mobile is mature enough to know what genuinely overlaps.
- Mobile mirrors views into a local SQLite cache (same shape as desktop's
  remote-mirror), and serves `agentview://` out of it.
- All SQL/schema/protocol logic stays in `shared/` TS. The mobile SQLite
  driver is in Rust (rusqlite via Tauri commands); `shared/db/sqlite.ts`
  grows a driver seam so the mobile build can substitute it.

Each step must end with `./scripts/build` green (desktop) plus
`cd mobile && npm run build:web` (mobile frontend) green once mobile is wired.

---

## Step 1 — Rename `src/` → `desktop/`  ✅

Pure mechanical move. No behaviour changes.

- `git mv src desktop`
- `package.json`:
  - `main`: `dist/src/main.js` → `dist/desktop/main.js`
- `tsconfig.json`: `include` `src/**/*` → `desktop/**/*`
- `scripts/build`:
  - `const src = join(root, 'src')` → `const desktop = join(root, 'desktop')`
  - `distSrc` → `distDesktop` (`dist/src` → `dist/desktop`)
  - Update every `cpSync` source path and `inlinePreload(distSrc)` call
  - Update the renderer mirror line:
    `cpSync(join(dist, 'shared'), join(distDesktop, 'renderer', 'shared'), …)`
- `scripts/start`, `scripts/package`, `scripts/preview`, `scripts/make`:
  audit each for hardcoded `src/` or `dist/src/` paths
- `desktop/main.ts` line that builds `clientPath`: still relative
  (`import.meta.dirname`-based), no edit needed
- `desktop/agent-meta.ts` / `desktop/window-manager.ts` etc.: no internal
  `src/` literals expected; grep to confirm
- `CLAUDE.md`: update the "renderer is served via `app://` rooted at
  `dist/renderer/`" note to `dist/desktop/renderer/`, and all other `src/`
  references in that file

Done when: `./scripts/build && ./scripts/start` launches the desktop app
exactly as before.

## Step 2 — `desktop/` build hardening  ✅

Walk through every dev path that the rename could have missed:

- `./scripts/preview` (Docker + VNC harness) launches the built app
- `./scripts/make` packages a distributable
- `desktop/auto-updater.ts` doesn't hardcode a `src/` path in update URLs
- Demos under `demos/` don't reference `src/`
- `.gitignore` patterns

Done when: `./scripts/package` produces a working app bundle.

## Step 3 — Mobile build wiring  ✅

Make the mobile frontend compile against `shared/` the same way desktop does
— no Vite, no separate `typescript` install; same tsgo + asset cpSync + import
map pattern the desktop renderer uses.

- Root `tsconfig.json` includes `mobile/**/*` so tsgo emits
  `dist/mobile/src/main.js` next to the desktop output. `#shared/*` resolution
  reuses the root config's `paths` and `imports` entries.
- `scripts/build` copies `mobile/index.html` and `mobile/src/styles.css` into
  `dist/mobile/`, then mirrors `dist/shared/` into `dist/mobile/shared/` for
  the runtime import map (same shape as `dist/desktop/renderer/shared/`).
- `mobile/index.html` declares `<script type="importmap">{"#shared/":"/shared/"}</script>`
  and links the CSS via `<link rel="stylesheet">` instead of a JS-side
  `import './styles.css'` (Vite-only convention).
- `mobile/src/main.ts` carries a trivial `import type { AgentBackend } from
  '#shared/backend/interface.js'` to prove the alias resolves.
- `mobile/src-tauri/tauri.conf.json`: `frontendDist` → `../../dist/mobile`;
  `beforeDevCommand`, `devUrl`, `beforeBuildCommand` removed — Tauri serves
  the prebuilt assets directly.
- `mobile/package.json`: `vite` and `typescript` removed; `dev`/`build`/
  `ios:dev*`/`android:dev*` chain through a `prebuild-frontend` script that
  invokes the root `scripts/build`.
- `mobile/tsconfig.json` deleted — root config covers it.
- `@tauri-apps/api` removed. The Tauri runtime auto-injects
  `window.__TAURI_INTERNALS__.invoke` into the webview, so the equivalent of
  the desktop preload's `contextBridge` lives in `mobile/src/tauri-bridge.ts`:
  a hand-rolled typed object surface that wraps `invoke` into domain
  namespaces. Future Rust commands (Step 5+) extend `bridge.*` instead of
  reaching back to `@tauri-apps/api`.
- `@tauri-apps/cli` removed; `mobile/package.json` + `node_modules` deleted.
  `tauri-cli` is now vendored: `scripts/setup` runs
  `cargo install tauri-cli --root vendor/tauri-cli --locked --version X` and
  records the version in `vendor/tauri-cli/version`. Skipped gracefully if
  `cargo` is absent (desktop-only contributors). Wrapper scripts at
  `scripts/{mobile-tauri,mobile-run,mobile-doctor}` set the iOS PATH/`DEVELOPER_DIR`
  and call the vendored binary.

Done when: `./scripts/build` succeeds with the `#shared/` type import in
`main.ts` and produces `dist/mobile/{index.html, src/main.js,
src/tauri-bridge.js, src/styles.css, shared/}`. `mobile/` contains no
`node_modules`, `package.json`, or `package-lock.json`.

## Step 4 — Driver seam in `shared/db/sqlite.ts`  ☐

`shared/db/sqlite.ts` currently hard-imports `better-sqlite3`. Split it:

- New `shared/db/driver.ts` defining a `SqliteDriver` interface:
  `prepare(sql) -> Statement`, `exec(sql)`, `transaction(fn)`,
  `close()`. Statement has `run/get/all/iterate` matching what
  `runAgentDbSql` actually uses.
- `shared/db/sqlite.ts` exports the SQL/schema logic and accepts a
  `SqliteDriver` (passed in by the host instead of imported)
- `shared/db/drivers/better-sqlite3.ts`: the existing impl, used by
  desktop and the remote daemon
- Mobile will provide `mobile/src/sqlite-driver.ts` later (Step 6) that
  calls into Rust via Tauri commands

Desktop and `remote-backend-server` must keep working — both wire up the
better-sqlite3 driver at the same call sites that used to import it
directly.

Done when: `./scripts/build` green and the desktop app still reads/writes
its local agent DB.

## Step 5 — Mobile Rust SQLite + commands  ☐

`mobile/src-tauri/Cargo.toml`: add `rusqlite` (bundled feature) and
`serde`/`serde_json`.

`mobile/src-tauri/src/lib.rs`:

- A `MirrorDb` state holding a `rusqlite::Connection`, opened at
  `app_data_dir()/agents/<agentId>/agent.db`
- Tauri commands the TS side will call:
  - `mirror_db_open(agent_id)` — opens/creates the mirror DB
  - `mirror_db_exec(sql)` — for DDL on the mirror
  - `mirror_db_run(sql, params)` — for inserts/updates/deletes during sync
  - `mirror_db_query(sql, params)` — returns rows as JSON
  - `mirror_db_apply_change(change_json)` — single entry point for the
    sync loop; equivalent to `applyAgentDbMirrorChange` but in Rust
  - `mirror_db_replace_snapshot(bytes)` — wholesale snapshot replace
- All commands take `agent_id` so a future multi-agent mobile UX
  doesn't need a re-architecture

Done when: a Tauri command from `mobile/src/main.ts` can open an empty
mirror DB and round-trip a basic `SELECT 1`.

## Step 6 — Mobile sqlite driver + RemoteBackend wiring  ☐

`mobile/src/sqlite-driver.ts`: implements `SqliteDriver` from Step 4
by calling the Tauri commands from Step 5.

`mobile/src/remote-mirror.ts`: a Tauri-flavoured port of
`desktop/remote-agent-db-sync.ts`. Same protocol (snapshot fetch +
`db:changed` stream), but uses the mobile sqlite driver to apply
changes.

`mobile/src/backend.ts`: instantiates `RemoteBackend` from
`#shared/backend/remote.js`, wires it to the mirror.

Done when: pointing the mobile app at a running
`remote-backend-server` populates the mirror DB and reflects daemon-side
changes (verify with a hand-written `SELECT * FROM views` via a debug
button).

## Step 7 — `agentview://` in Rust  ☐

Custom URI scheme handler in `mobile/src-tauri/src/lib.rs` via
`tauri::Builder::register_uri_scheme_protocol`.

The handler is a thin Rust port of `desktop/protocol/view-handler.ts`:

- `agentview://module/<name>` → reads `modules` row from mirror SQLite,
  returns content with the right MIME (port
  `getModuleContentType`)
- `agentview://file/<path>` and asset routes — defer; mobile views can
  start without file-source support, add later if needed
- `agentview://view/<name>` → reads `views` row from mirror SQLite,
  wraps in the standard view HTML

For the view HTML wrapper: don't reimplement `buildViewDocument` in
Rust. Pre-compute the template at build time:

- `mobile/src-tauri/build.rs` reads `shared/protocol/view-document.ts`'s
  template constants (or a tiny JSON the build script writes out) and
  bakes them into the Rust binary as `&'static str`s
- Or simpler: extract the literal HTML template into a `.html` file
  under `shared/protocol/` that both the TS function and the Rust
  handler include verbatim

Done when: a hand-inserted `views` row in the mirror DB renders inside
the mobile app via an `<iframe src="agentview://view/hello">`.

## Step 8 — Mobile UI shell  ☐

Touch-first single-context UI. Out of scope for this plan beyond the
skeleton — flesh out in a follow-up. The skeleton needs:

- Pick-an-agent screen (list daemons configured in
  `~/.agentwfy.json`'s `remoteBackends`, same shape desktop already
  uses)
- Sessions list + new-session button
- Chat view with streaming
- View tab(s) using `<iframe src="agentview://...">`

All UI talks to the backend through the `AgentBackend` interface from
`shared/backend/interface.ts`. No Tauri-specific code leaks past
`mobile/src/backend.ts` and `mobile/src/sqlite-driver.ts`.

Done when: end-to-end "open agent, send a message, see streamed reply,
open a view" works on iOS simulator.

---

## Open questions to revisit later

- **Trigger UI on mobile.** `shared/triggers/` is daemon-side; the
  mobile UI may want to list/disable triggers but the daemon owns
  lifecycle. Mirror the `triggers` table read-only.
- **HTTP API exposure.** The daemon's HTTP API (port 9877) is unchanged;
  mobile doesn't need its own. Reaching the daemon from outside
  localhost is a network/deployment problem, not a code problem.
- **Auth.** Mobile and daemon need a shared secret or token. Not in
  this plan.
- **Push.** iOS APNs for daemon-side notifications. Out of scope here.
