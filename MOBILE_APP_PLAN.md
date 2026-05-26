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

## Step 5 - Implement the chat workflow

This is the first user-facing product slice.

- Render display messages from `SessionState.messages`.
- Apply live patches from `session:state`:
  streaming message, status line, retry state, stalled state, title updates,
  and message replacement when the backend sends a fresh message array.
- Composer behavior:
  send first prompt by spawning a session, send follow-up messages to the
  active session, disable impossible actions while disconnected, and support
  abort while streaming.
- Preserve the active session across reconnect when possible; show a clear
  disconnected state without destroying local UI state.
- Defer file attachments unless needed for MVP; keep the controller method
  shape compatible with `FileContent[]`.

Done when: "connect -> new chat -> send prompt -> stream reply -> send
follow-up -> abort/retry state behaves sanely" works on iOS simulator.

## Step 6 - Implement `window.agentwfy` for mobile views

Static view rendering is already present, but real AgentWFY views expect host
APIs through `window.agentwfy.<method>(...)`.

- Inject a mobile view-host script into served view documents, or extend the
  shared view bootstrap with a host-provided hook.
- In the view frame, expose `window.agentwfy` as an async function proxy.
  Calls should post messages to the parent app with `{ id, name, params }`.
- In the mobile parent UI, validate the message source and route calls through
  `activeBackend.functions.invoke({ name, params })`.
- Ensure `runSql` uses the mobile mirror path already implemented by
  `MobileRemoteMirror`, so read queries are local and mutating queries wait for
  daemon catch-up.
- Return structured errors to the frame so existing views can handle failures.
- Add a small compatibility check with existing system/user views that call
  `window.agentwfy.runSql(...)`.

Done when: a mirrored view that calls `window.agentwfy.runSql` can read and
mutate agent DB state from the mobile app.

## Step 7 - Build the view surface

Expose agent views as first-class mobile screens.

- Query mirrored `views` for name/title/description and keep the list fresh
  from `views` table DB-change notifications.
- Open a selected view in an iframe using `agentview://localhost/view/<name>?tabId=<id>`.
- Preserve one active view while moving between chat and views.
- Add reload and close controls.
- Handle missing/deleted views, snapshot replacement, and reconnect refresh.
- Keep `/file/*` and `/asset/*` routes deferred unless an MVP view needs
  them. (Desktop serves these from the agent's data dir / bundled client
  assets; mobile would need a parallel filesystem mirror to match.)

Done when: after chatting, the user can open a view produced by the agent, the
view can call `window.agentwfy`, and the view refreshes when its DB row changes.

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
