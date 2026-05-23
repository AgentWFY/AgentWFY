# Mobile remote-agent app implementation plan

This replaces the completed host-split plan. The repository now has the
mobile host, remote daemon, native SQLite mirror, snapshot sync, and
`agentview://` rendering path in place. The remaining work is to turn the
debug harness into a usable remote-agent mobile app.

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
  `modules` through `agentview://`.
- `mobile/src/main.ts` is still a debug mirror harness. It should be replaced,
  not extended into the product UI.

Target MVP: on an iOS simulator and a real device, a user can add a remote
daemon profile, connect, open or create a session, send messages, see streamed
replies, and open a mirrored agent view.

## Step 1 - Lock the current end-to-end smoke path

Before replacing the harness, make the existing path repeatable enough that UI
work is not debugging transport at the same time.

- Document the exact daemon/mobile smoke flow in `mobile/README.md`:
  daemon env vars, `AGENTWFY_REMOTE_PORT`, token, simulator/device URL
  expectations, and the query/render checks.
- Verify on simulator:
  connect, snapshot applied, `SELECT ... FROM views` returns rows,
  `agentview://view/<name>` renders, and daemon-side DB changes reach the
  mirror.
- Verify at least one non-localhost URL path. A real iOS device cannot reach
  the developer machine through `127.0.0.1`; use LAN IP, tunnel, or HTTPS
  daemon endpoint.
- Add small debug logging around snapshot/version failures if the simulator
  gives opaque WebView errors.

Done when: a developer can follow `mobile/README.md` from a clean build and
prove that transport, mirror sync, and view rendering work before touching the
new UI.

## Step 2 - Introduce a mobile app state layer

Replace one-off DOM handlers with a small state/controller layer that owns the
active backend and exposes plain render state to the UI.

- Add a controller for one active remote agent:
  profile, connection status, `MobileBackend`, active session, session list,
  provider state, mirrored view list, and current screen.
- Centralize backend lifecycle:
  create, start, subscribe, reconnect, stop, and cleanup on profile switch.
- Subscribe to `backend.status`, `backend.events`, and mirror DB-change
  callbacks in one place.
- Keep Tauri-specific calls behind `mobile/src/backend.ts` and
  `mobile/src/tauri-bridge.ts`; UI code should talk to controller methods and
  `AgentBackend` concepts.

Done when: the debug form can be removed without losing the ability to connect
and observe status/snapshot changes.

## Step 3 - Add remote profile storage and connection UX

The app needs persistent daemon profiles instead of a hard-coded debug form.

- Add typed profile commands behind `bridge.profiles.*`:
  list, save, remove, get last active profile, set last active profile.
- Store profile metadata in Tauri app data. Keep token access isolated behind
  this bridge so it can move to Keychain/Keystore without touching the UI.
- Profile fields for MVP:
  `id`, `label`, `baseUrl`, `agentId`, `agentToken`, `lastConnectedAt`.
- Build touch-first screens for profile list, add/edit profile, connection
  error, reconnect, and forget profile.
- Validate inputs before starting a backend:
  absolute HTTP(S) URL, non-empty token when required, no trailing slash
  dependency.

Done when: app launch shows saved profiles, can add a daemon manually, can
connect, can reconnect after restart, and can delete the profile.

## Step 4 - Build sessions and provider basics

Give the user enough navigation to choose an existing conversation or start a
new one.

- Load `backend.providers.getState()` after connect and expose provider names,
  default provider, and status lines.
- Load `backend.sessions.list()` and refresh from session events:
  `session:created`, `session:removed`, `session:saved`, `session:loaded`.
- Implement session selection with `backend.sessions.get({ sessionId })`.
- Implement new-session creation through `backend.sessions.spawn(...)`.
- Support removing a session with confirmation.

Done when: after connecting, the app shows recent sessions, can open one, can
start a new one, and provider/default status is visible enough to diagnose
missing provider config.

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
- Open a selected view in an iframe using `agentview://view/<name>`.
- Preserve one active view while moving between chat and views.
- Add reload and close controls.
- Handle missing/deleted views, snapshot replacement, and reconnect refresh.
- Keep `agentview://file/*` and asset routes deferred unless an MVP view
  needs them.

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
- File-backed `agentview://file/*` and bundled asset routes.
- QR-code profile import/export.
