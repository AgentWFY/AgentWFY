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
- `shared/` splits into two de-facto layers:
  - **Contracts / browser-safe** — `shared/backend/{interface,protocol,
    remote,ws_client}.ts`, the `AgentDbChange` shape and snapshot protocol
    constants. Mobile reuses these directly.
  - **Node-only runtime** — `shared/db/agent-db.ts`, `shared/db/sqlite.ts`,
    `shared/runtime/`, `shared/triggers/`. Used by desktop main and the
    daemon. Mobile does **not** reuse this layer.
- The mirror seam is `RemoteDbSync` in `shared/backend/remote.ts`, already
  async-friendly. Desktop attaches `RemoteAgentDbSync` (Node fs +
  `node:sqlite`); mobile will attach a Tauri-flavoured implementation that
  calls into Rust (rusqlite via Tauri commands). No driver swap inside
  `shared/db/sqlite.ts` — that path would force `await` through every Node
  consumer for zero benefit.

Each step must end with `./scripts/build` green. For mobile-only wiring,
`./scripts/build-mobile` is the narrower check.

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

- `mobile/tsconfig.json` scopes tsgo to `mobile/src/**/*` plus `shared/**/*`,
  emitting `dist/mobile/src/main.js` next to the desktop output. `#shared/*`
  resolution matches the other host-specific configs.
- `scripts/build-mobile` copies `mobile/index.html` and
  `mobile/src/styles.css` into `dist/mobile/`, then mirrors `dist/shared/` into
  `dist/mobile/shared/` for the runtime import map (same shape as
  `dist/desktop/renderer/shared/`). `scripts/build` delegates to the per-host
  scripts for desktop, mobile, and the remote daemon.
- `mobile/index.html` declares `<script type="importmap">{"#shared/":"/shared/"}</script>`
  and links the CSS via `<link rel="stylesheet">` instead of a JS-side
  `import './styles.css'` (Vite-only convention).
- `mobile/src/main.ts` carries a trivial `import type { AgentBackend } from
  '#shared/backend/interface.js'` to prove the alias resolves.
- `mobile/src-tauri/tauri.conf.json`: `frontendDist` → `../../dist/mobile`;
  `beforeDevCommand`, `devUrl`, `beforeBuildCommand` removed — Tauri serves
  the prebuilt assets directly.
- `mobile/package.json`, `package-lock.json`, and `node_modules` deleted. The
  checked-in workflow is now `scripts/build-mobile` for frontend compilation
  and `scripts/mobile-run <tauri-args>` for Tauri commands.
- `@tauri-apps/api` removed. The Tauri runtime auto-injects
  `window.__TAURI_INTERNALS__.invoke` into the webview, so the equivalent of
  the desktop preload's `contextBridge` lives in `mobile/src/tauri-bridge.ts`:
  a hand-rolled typed object surface that wraps `invoke` into domain
  namespaces. Future Rust commands (Step 5+) extend `bridge.*` instead of
  reaching back to `@tauri-apps/api`.
- The npm `@tauri-apps/cli` dependency was removed. `tauri-cli` is now
  vendored: `scripts/setup` runs
  `cargo install tauri-cli --root vendor/tauri-cli --locked --version X` and
  records the version in `vendor/tauri-cli/version`. Skipped gracefully if
  `cargo` is absent (desktop-only contributors). Wrapper scripts at
  `scripts/{mobile-tauri,mobile-run,mobile-doctor}` set the iOS PATH/`DEVELOPER_DIR`
  and call the vendored binary.

Done when: `./scripts/build` succeeds with the `#shared/` type import in
`main.ts` and produces `dist/mobile/{index.html, src/main.js,
src/tauri-bridge.js, src/styles.css, shared/}`. `mobile/` contains no
`node_modules`, `package.json`, or `package-lock.json`.

## Step 4 — (withdrawn) Driver seam in `shared/db/sqlite.ts`

The original premise was wrong on two counts and there's no work to do
here. Recording the reasoning so future-us doesn't re-propose it.

- `shared/db/sqlite.ts` does not use `better-sqlite3`. It uses Node's
  built-in `node:sqlite` (`DatabaseSync` / `StatementSync`), which is
  **synchronous**. The actual driver code is in
  `shared/db/agent-db.ts` (the `AgentDb` class, 754 lines), and every
  caller — desktop main, the remote daemon, sub-agents, triggers, tasks,
  the runtime function registry — assumes sync semantics throughout.
- Tauri's `invoke` is unavoidably async. A `SqliteDriver` interface that
  spans both Node and the mobile WebView would either (a) become async
  and pessimize the two sync consumers that do all the real SQL work, or
  (b) stay sync and be unimplementable on mobile. Both options are bad.
- The real seam already exists: `RemoteDbSync` in
  `shared/backend/remote.ts` is async-shaped (`start(): Promise<void>`,
  `runSql(payload): Promise<unknown[]>`) and is hooked into
  `RemoteBackend` via `attachDbSync(...)`. Desktop attaches
  `desktop/remote-agent-db-sync.ts` (`RemoteAgentDbSync`, Node-flavoured).
  Mobile will attach its own Tauri-flavoured implementation in Step 6.

What's actually shared between desktop and mobile remote-mirrors is the
**contracts** (browser-safe TS):

- `shared/backend/remote.ts` — `RemoteBackend`, `RemoteDbSync` interface,
  `getAgentDbSnapshotRequest()`, `subscribeDbChanges(...)`.
- `shared/backend/protocol.ts` — `DB_SNAPSHOT_PATH`,
  `DB_SNAPSHOT_VERSION_HEADER`, RPC envelopes.
- `shared/backend/ws_client.ts` — browser-safe WebSocket transport
  (already DOM-compatible).
- `shared/db/sqlite.ts`'s exported `AgentDbChange` shape — the only
  thing mobile imports from this file. It happens to live in a file that
  also has `runAgentDbSql` (Node-only); the type import is erased at
  compile time, so the Node dependency doesn't leak into the mobile
  bundle.

What we deliberately do **not** extract:

- The mirror's state machine (version tracking, gap detection, snapshot
  fetch, epoch handling, version waiters) in
  `desktop/remote-agent-db-sync.ts`. ~200 lines, intricate, and its IO
  hooks (Node `fs`/stream-pipeline vs. Tauri `invoke`) are different
  enough that abstracting them would cost more than the duplication.
  Mobile ports the state machine ground-up in Step 6.
- Schema DDL. The daemon ships a full SQLite-file snapshot; replacing
  the mirror file bytes also brings the schema. Rust never needs to
  execute `CREATE TABLE` — opening the snapshot file is the schema.

Done when: nothing to do — proceed to Step 5.

## Step 5 — Mobile Rust SQLite + commands  ✅

`mobile/src-tauri/Cargo.toml`: add `rusqlite` (bundled feature) and
`serde`/`serde_json`.

`mobile/src-tauri/src/lib.rs`:

- A `MirrorDb` state holding a `rusqlite::Connection`, opened at
  `app_data_dir()/agents/<agentId>/agent.db`. Keyed by `agent_id` so a
  future multi-agent mobile UX doesn't need a re-architecture; the
  initial UI may only use one slot, but the command surface accepts the
  key everywhere.
- Tauri commands the TS side will call:
  - `mirror_db_open(agent_id)` — opens the mirror file if it exists;
    otherwise returns a `not_initialized` status. The TS side reacts by
    triggering a snapshot fetch (no DDL is run here — see below).
  - `mirror_db_query(agent_id, sql, params)` — `SELECT`-style reads,
    returns rows as JSON. Used by the `agentview://` handler (Step 7)
    and any debug UI.
  - `mirror_db_apply_change(agent_id, change_json)` — single entry
    point for the sync loop; equivalent to `applyAgentDbMirrorChange` in
    `shared/db/agent-db.ts`, ported to Rust. Bypasses any guard triggers
    (mobile mirror has none — see schema note below) and uses upsert by
    `name`. Reads `change_json` against the `AgentDbChange` shape from
    `shared/db/sqlite.ts` (snake-cased on the wire for Rust ergonomics or
    passed verbatim; pick whichever; document in the command).
  - `mirror_db_replace_snapshot(agent_id, bytes)` — atomic
    snapshot-file replace. Closes the connection, writes the bytes to a
    tempfile next to `agent.db`, renames into place, deletes any
    `-wal`/`-shm` siblings, reopens. The snapshot is a full SQLite
    database file from the daemon — the schema travels with the bytes,
    so Rust never executes `CREATE TABLE` and never needs to know the
    DDL.

Notes:

- No `mirror_db_exec(sql)` / `mirror_db_run(sql, params)` command. The
  mirror is read-only from the TS side except for the two structured
  entry points above; arbitrary SQL writes would be a footgun and aren't
  needed for the sync loop.
- The mirror DB file format is the same SQLite format the daemon writes,
  so on-disk forensics (`sqlite3 agent.db` on the iOS sandbox) work the
  same way as on desktop.

Done when: a Tauri command from `mobile/src/main.ts` can open an empty
mirror DB (after `mirror_db_replace_snapshot` is fed a daemon snapshot)
and round-trip a `SELECT name FROM views` showing the daemon-side rows.

## Step 6 — Mobile remote-mirror + RemoteBackend wiring  ✅

`mobile/src/remote-mirror.ts`: ground-up port of
`desktop/remote-agent-db-sync.ts` that implements the `RemoteDbSync`
interface from `shared/backend/remote.ts`. Reuses the same protocol
(snapshot fetch + `db:changed` stream + version-gated `runSql`), but
the IO surface is different:

| Concern             | Desktop (existing)                         | Mobile (new)                                                  |
|---------------------|--------------------------------------------|---------------------------------------------------------------|
| Local DB writes     | `applyAgentDbMirrorChange` (sync, in-proc) | `await invoke('mirror_db_apply_change', { agentId, change })` |
| Snapshot install    | stream-pipeline → tmp file → rename        | `arrayBuffer()` → `invoke('mirror_db_replace_snapshot', …)`   |
| Snapshot existence  | `fs.existsSync(getAgentDbPath(...))`       | `invoke('mirror_db_open', …)` returns `not_initialized` flag  |
| `runSql` read path  | `runAgentDbSql(cacheRoot, request)` (sync) | `invoke('mirror_db_query', …)` for read-only SELECTs          |
| `runSql` write path | RPC to daemon, then `waitForVersion`       | identical — RPC to daemon, then `waitForVersion`              |

The state machine itself (version tracking, `buffered` queue, snapshot
epochs, `versionWaiters`, `onHello`/`onReset`, gap detection,
`tryApply`'s `applied`/`duplicate`/`gap`/`unreplayable` enum) ports
across as-is. Roughly 200 lines of state-machine logic, no Node
imports.

`mobile/src/backend.ts`: instantiates `RemoteBackend` from
`#shared/backend/remote.js` against a daemon URL + agent token from
config, constructs the mirror, and calls
`remoteBackend.attachDbSync(mirror)` before `remoteBackend.start()`.
Mirrors the wiring in `desktop/agent-context-remote.ts:42-48`.

Done when: pointing the mobile app at a running `remote-backend-server`
fetches a snapshot, applies live `db:changed` events, and a debug
`mirror_db_query('SELECT * FROM views')` reflects the daemon's current
state.

## Step 7 — `agentview://` in Rust  ✅

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
- **Residual async races in `MobileRemoteMirror`.** The desktop sync is
  synchronous end-to-end (`node:sqlite` + Node `fs`), so its state machine
  never crosses an `await`. The mobile port crosses one at every IO point
  (Tauri commands, `fetch`). The most load-bearing race windows — between
  `replaceSnapshot` returning and the localVersion assignment, and between
  `applyChange` returning and `localVersion = change.version` — are guarded
  by re-checks after the await. Remaining smaller windows exist (e.g.
  `onRemoteChange` deciding not to buffer, then `dispatchChange` crossing an
  await before the apply lands) and are self-healing via gap detection
  triggering a fresh snapshot. A more invasive fix is a per-mirror async
  queue that serializes all state mutations; defer until empirical churn
  during reconnects justifies it.
- **`mirror_db_replace_snapshot` tmp filename uniqueness.** Uses
  `agent.db.snapshot.{pid}.tmp` — safe today because the TS `snapshotPromise`
  gate prevents concurrent in-flight snapshots per agent. If/when multiple
  mirror connections become possible (true multi-agent UX, or sub-agent
  pool), include the `agent_id` and a random suffix in the tmp filename to
  remove the implicit single-writer assumption.
- **Child webviews vs. iframes for view embedding.** Tauri 2.11's
  `Window::add_child` (the Rust-side "spawn a webview inside this window"
  API) is gated `#[cfg(any(test, all(desktop, feature = "unstable")))]`:
  multi-webview is desktop-only. On iOS/Android there is no Rust API to
  embed an `agentview://` webview as a region of the current screen.
  Step 7 and Step 8 therefore use `<iframe src="agentview://...">` — the
  subframe is a real native webview (a WKWebView child frame on iOS;
  WebView2 / WebKitGTK on the desktop targets), the `agentview://` scheme
  handler reads from the same Rust-owned mirror DB regardless, and
  rendering is equivalent. When Tauri ships mobile multi-webview, the
  swap is local to four spots: enable the `unstable` Cargo feature, add
  the (already-prototyped-and-reverted) `agent_view_open/reposition/close`
  commands behind a cfg gate, add a `bridge.agentView.*` namespace, and
  replace the `<iframe>` mount in `mobile/src/main.ts`.
