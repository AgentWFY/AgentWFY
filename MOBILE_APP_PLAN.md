# Mobile remote-agent app implementation plan

This replaces the completed host-split plan. The repository now has the
mobile host, remote daemon, native SQLite mirror, snapshot sync, and the
view rendering path in place. The remaining work is to turn the debug
harness into a usable remote-agent mobile app.

## Current baseline

- `mobile/` is a Tauri v2 remote-only client. It builds through
  `./scripts/build-mobile` and runs through `./scripts/mobile-run`.
- `mobile/src/backend.ts` creates a `RemoteBackend` and attaches
  `MobileRemoteMirror`.
- `mobile/src/remote-mirror.ts` pulls daemon snapshots, applies live
  `db:changed` events, and gates mutating `runSql` calls on mirror catch-up.
- `mobile/src-tauri/src/mirror_db.rs` owns the local SQLite mirror via
  `rusqlite`.
- `mobile/src-tauri/src/view_protocol.rs` serves mirrored `views` and
  `modules` over the `agentview://` custom URI scheme using path-based
  routing (`/view/<name>`, `/module/<name>`). The scheme is an iOS
  WKWebView implementation detail — agents only ever see scheme-free
  paths in markdown, and views use relative URLs internally.
- `mobile/src/main.ts` is still a debug mirror harness. It should be replaced,
  not extended into the product UI.

Target MVP: on an iOS simulator and a real device, a user can add a remote
daemon profile, connect, open or create a session, send messages, see streamed
replies, and open a mirrored agent view.

## Step 1 - Lock the current end-to-end smoke path - DONE

Harness (`scripts/mobile-preview`) and full smoke recipe live in
[`docs/MOBILE_TESTING.md`](docs/MOBILE_TESTING.md); `mobile/README.md` points
to it. Verified on simulator: connect, snapshot applied, `SELECT ... FROM
views` returns rows, `agentview://localhost/view/<name>?tabId=mobile` renders,
and daemon-side DB changes reach the mirror.

Real-device / non-localhost daemon verification stays deferred to Step 8.

## Step 2 - Introduce a mobile app state layer - DONE

`AppController` (`mobile/src/app-controller.ts`) owns the single active remote
agent: profile, status, `MobileBackend`, sessions, active session, provider
state, mirrored views, screen, last mirror sync, and last DB change. UI
subscribes via `controller.subscribe(state => …)` and calls `connect` /
`disconnect` / `setScreen`; the controller centralizes backend lifecycle
(teardown-then-connect with a generation counter so overlapping connects
don't leak a session) and routes `backend.status`, `backend.events`, and
mirror callbacks into one state stream. `main.ts` is now a thin debug shell
on top of the controller — the form, query button, and view frame all read
controller state instead of touching the backend directly. Session, provider,
and view loading remain stubs; Steps 4 and 7 fill them in.

## Step 3 - Persist remote agents and add a connect UX - DONE

Mirrors desktop's storage model rather than inventing a mobile-only "profile"
concept:

- `mobile/src-tauri/src/store.rs` is a generic JSON key/value store at
  `<appData>/config.json` exposing `store_get/set/remove`. Same shape as
  the Electron internal store on desktop (`desktop/ipc/store.ts`).
- `mobile/src/store.ts` is an async wrapper around `bridge.store.*`.
- `mobile/src/agent-meta.ts` is a direct port of `desktop/agent-meta.ts`:
  `RemoteAgentConfig`, `AgentMeta`, and `getAgentMeta/setAgentMeta/removeAgentMeta`
  read/write the `installedAgentMeta` key. The same file owns the
  `installedAgents` ordered-id list and a `listInstalledAgents()` join.
- Mobile is remote-only, so `AgentMeta` here drops the `backend: 'local'`
  variant the desktop union carries. If mobile ever caches a local copy,
  this collapses back to the full desktop union without a schema rename.
- `AppController` swaps `Profile` for `{ agentId, meta }` and validates
  add inputs inline (same trim + http(s) regex + trailing-slash strip as
  `desktop/command-palette/manager.ts` `add-remote-agent`). Methods:
  `refreshAgents`, `addRemoteAgent`, `removeAgent`, `connect(agentId)`.
- `mobile/src/main.ts` renders an agents-list screen (tap to connect,
  per-row Remove) and an add-agent form (no edit — desktop has no edit
  either; remove + re-add). Connected screen is a placeholder with
  Disconnect / Remove until Step 5 lands real chat.

There is no "lastActive" or `lastConnectedAt` field — desktop doesn't have
those either. Launch picks the first installed agent only as a UI hint;
auto-connect is deferred.

## Step 4 - Build sessions and provider basics - DONE

The connected mobile screen now gives the user enough navigation to choose an
existing conversation or start a new one.

- `AppController` loads `backend.providers.getState()` after connect and
  exposes provider names, default provider, and status lines in `AppState`.
- `AppController` loads `backend.sessions.list()` after connect and refreshes
  from `session:created`, `session:removed`, `session:saved`, and
  `session:loaded`.
- Session selection uses `backend.sessions.get({ sessionId })` and stores the
  full `SessionState` as `activeSession`.
- New-session creation uses `backend.sessions.spawn(...)`, then loads the
  created session so the UI can transition immediately.
- Session removal uses `backend.sessions.remove({ sessionId })`, clears the
  active session when needed, and the UI asks for confirmation before calling
  it.
- `shared/backend/local.ts` now emits the existing `session:created` backend
  event from `sessions.spawn`, so mobile uses the same backend event stream as
  desktop/server rather than a mobile-only path.
- `mobile/src/main.ts` renders provider diagnostics, recent sessions, a
  new-session prompt form, an active-session placeholder, and remove controls.

Verified with `./scripts/build` (desktop, mobile, and remote server).

## Step 5 - Implement the chat workflow - DONE

This is now the first user-facing product slice:

- `AppController` exposes `sendMessage(...)` and `abortActiveSession()`.
  `sendMessage` spawns a session when no session is active, sends follow-up
  messages to the active session, validates disconnected/empty-prompt states,
  and keeps the call shape compatible with `FileContent[]`.
- `AppController` remembers the active session id per agent and reloads it
  after reconnect when the daemon still has that session. Temporary remote
  disconnect/reconnect status changes keep the local chat UI mounted.
- `session:state` patches now drive the active chat surface: fresh message
  arrays replace committed messages, `streamingMessage` renders live at the
  end of the transcript, title updates flow into both active chat and the
  session list, and retry/stalled/status-line states are visible.
- `mobile/src/main.ts` renders a real chat screen: session picker with a
  first-message composer, active transcript, follow-up composer, abort button,
  and live status row. The message/status areas update in place so streaming
  patches do not erase composer drafts.
- `mobile/src/styles.css` adds the mobile chat layout, message bubbles,
  tool/error/file rendering, retry/stall tones, composer states, and dark-mode
  variants.

Verified with `./scripts/build-mobile` and the iOS simulator preview
(`./scripts/mobile-preview`) against a local remote daemon with
`plugins/test-provider` installed and selected by default. Smoke covered:
connect, first prompt streaming/commit, follow-up send, aborting a slow
stream, showing and aborting a retry state, and preserving/reloading the
active chat after daemon restart.

## Step 6 - Implement `window.agentwfy` for mobile views - DONE

Static view rendering is already present, but real AgentWFY views expect host
APIs through `window.agentwfy.<method>(...)`.

Mobile now mirrors the desktop preload bridge for `agentview://` documents:

- `mobile/src-tauri/src/view_protocol.rs` injects a small mobile host script
  into served DB views alongside the existing shared view bootstrap.
- The view frame exposes `window.agentwfy` as an async method proxy. Calls post
  `{ id, name, params }` messages to the parent app and receive structured
  success/error replies.
- `mobile/src/main.ts` validates that messages came from an iframe whose source
  is `agentview://localhost/...`, checks the call against the active backend's
  sync function-name list, and routes through
  `backend.functions.invoke({ name, params })`.
- `runSql` automatically uses the existing `MobileRemoteMirror` path:
  read-only agent queries hit the local mirror, while mutating queries go to
  the daemon and wait for mirror catch-up before resolving.

Verified with `./scripts/build-mobile`, `./scripts/build-server`, and the iOS
simulator preview (`./scripts/mobile-preview`) against a local daemon with
`plugins/test-provider` installed and selected as the default provider. Smoke
covered: connect/snapshot, a mirrored DB view calling
`window.agentwfy.runSql` for both SELECT and INSERT/UPSERT, the inserted row
appearing in the mobile mirror DB, and a `normal` chat turn streaming through
`test-provider`.

## Step 7 - Build the view surface - DONE

Agent views are now first-class mobile screens. The connected screen has a
Chat / Views tab nav; the Views tab lists every mirrored view and opens one
in an iframe.

- `AppController` queries the mirrored `views` table for `name, title` after
  connect and reloads from `onLocalDbChange` whenever the `views` table
  changes (insert, update, delete). The query reuses the desktop ORDER BY
  from `shared/db/views.ts:listViews`.
- `openView(name)` flips `screen` to `views`, sets `activeViewName`, and
  bumps a monotonic `viewVersion` counter. `closeView` clears
  `activeViewName`; `reloadView` only bumps `viewVersion`.
- The iframe src is
  `agentview://localhost/view/<name>?tabId=mobile-view&rev=<viewVersion>` —
  tabId carries a stable mobile-only token so the Rust handler classifies
  the request as a view DOCUMENT, and `rev` forces WKWebView to treat each
  bump as a fresh navigation.
- The iframe element is cached at module scope and reattached on each render
  so chat↔views round-trips keep WKWebView state. `src` is only rewritten
  when the active view name or version changes.
- Snapshot apply also bumps `viewVersion`, so a reconnect/snapshot refresh
  reloads the open view automatically. If the active view disappears from
  the catalog (deleted upstream), `activeViewName` is cleared and the banner
  surfaces "View "<name>" was removed."
- A DB change on the active view's row (matching `change.rowId` or
  `previousRowId`) bumps `viewVersion` so live updates land without a
  manual reload.
- `/file/*` and `/asset/*` mobile routes remain deferred — no MVP view needs
  them yet.

Verified with `./scripts/build-mobile`, `./scripts/build-server`, and the
iOS simulator preview (`./scripts/mobile-preview`) against the local daemon.
Smoke covered: listing the seeded `home` / `system.*` views, opening the
`home` view (iframe loads `agentview://localhost/view/home?tabId=mobile-view&rev=N`),
Reload bumping the rev, Close returning to the list, switching Chat↔Views
keeping the cached iframe (rev unchanged), a daemon-side INSERT showing up
as a new list row, an UPDATE on the active view bumping the iframe rev, and
a DELETE on the active view clearing the frame with the banner message.

## Step 8 - Mobile reliability and device readiness

Finish the app behavior that only shows up outside the desktop dev loop.

- Use safe-area-aware layout and test common iPhone viewport sizes.
- Handle app background/foreground:
  reconnect WebSocket, re-check hello DB version, and resnapshot on reset.
- Make connection errors actionable:
  auth failure, DNS/TLS failure, unreachable daemon, snapshot failure, and
  protocol mismatch.
- Confirm HTTPS/WSS daemon deployments work. Plain HTTP is acceptable for
  simulator/LAN development only.
- Review token storage before real device use; move token bytes into platform
  secure storage if profile JSON is not acceptable.
- Run:
  `./scripts/build-mobile`,
  `./scripts/build-server`,
  `./scripts/mobile-run ios dev`,
  and one real-device or LAN/tunnel smoke test.

Done when: the MVP flow works after app restart, network interruption, and
daemon restart.

## Deferred after MVP

- Multi-agent mobile switching. The mirror commands are already keyed by
  `agentId`, but the first UI should keep one active agent.
- Task/trigger management screens. Read-only task status can come first.
- Backup/restore UI.
- Plugin management UI.
- Push notifications from daemon to mobile.
- File-backed `/file/*` and bundled `/asset/*` routes on mobile.
- QR-code profile import/export.
