# Mobile Testing Guide

How to drive the mobile app on an iOS simulator without doing it by hand
each time. Parallel to [`TESTING.md`](TESTING.md), which covers the desktop
Docker+VNC preview.

The harness is `scripts/mobile-preview`. It boots a simulator, runs
`tauri ios build --debug --target aarch64-sim` to produce a `.app` with the
frontend embedded, then `simctl install`s and `simctl launch`es it. A debug
HTTP server inside the Rust shell exposes a UNIX socket so the harness can
run JS inside the WebView from outside.

Per-preview state lives in `~/.agentwfy/mobile-preview/<sim-slug>/`.

## Why this shape

Two iOS Simulator facts shape the design:

- **The sim's loopback is not the host's loopback.** `127.0.0.1` inside the
  sim isn't `127.0.0.1` on the host, so Tauri's default `ios dev` flow (dev
  server on host's `127.0.0.1:1430`) doesn't work — the app loads
  `tauri://localhost/` and fails. Solution: bundle the frontend via
  `tauri ios build` so there's no network round-trip needed.
- **`sockaddr_un` is capped at 104 bytes on macOS.** The simulator sandbox
  path alone is ~120+ chars, so the debug bridge can't bind a socket inside
  the app's data dir. Solution: bind in `/tmp/`. The simulator app runs as
  the host's user account, so both sides share `/tmp/`.

## One-time setup

```sh
./scripts/setup                                # vendors tauri-cli
./scripts/mobile-run ios init                  # iOS scaffolding
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
./scripts/mobile-preview --doctor
```

No `ios-webkit-debug-proxy` needed — iwdp v1.9.2 only enumerates USB-attached
devices, not simulators, and would also require `WKWebView.isInspectable`.
We bypass it entirely.

## Start a preview

```sh
./scripts/mobile-preview                       # default: iPhone 16 Pro
./scripts/mobile-preview --sim "iPhone 16"     # different simulator
```

First run is slow: simulator boot + full release-shape Rust build can take
several minutes. Subsequent restarts reuse cargo's incremental cache.

```sh
./scripts/mobile-preview --list                # running previews
./scripts/mobile-preview --restart <name>      # rebuild + reinstall + relaunch
./scripts/mobile-preview --stop [name]         # stop one or all; --shutdown halts the sim
```

`<name>` defaults to the slugified simulator name (e.g. `iPhone-16-Pro`). If
exactly one preview is running, subcommands that need a name pick it
implicitly.

## Driving the preview

### `--eval` — run JS in the WebView

```sh
./scripts/mobile-preview --eval iPhone-16-Pro "document.title"
./scripts/mobile-preview --eval iPhone-16-Pro \
  "Array.from(document.querySelectorAll('input')).map(i => ({name: i.name, value: i.value}))"
./scripts/mobile-preview --eval iPhone-16-Pro \
  "await new Promise(r => setTimeout(() => r({ok:true}), 100))"
```

The expression is wrapped in an async IIFE inside the WebView. Top-level
`await` works. Return `null` from side-effecting expressions —
`undefined` round-trips as `null` because JSON can't carry it. Exceptions
surface on stderr with the WebView stack trace and a non-zero exit.

Transport: HTTP over a UNIX socket at `/tmp/agentwfy-mobile-debug-bridge.sock`,
created by the Rust shell's `debug_bridge.rs` (debug builds only). The
shell injects a wrapper via `webview.eval(...)` and the wrapper reports
back through the `__debug_result` Tauri command.

### `--screenshot`

```sh
./scripts/mobile-preview --screenshot iPhone-16-Pro out.png
```

`xcrun simctl io <udid> screenshot` under the hood.

### `--sqlite` — on-device mirror DB

```sh
./scripts/mobile-preview --sqlite iPhone-16-Pro --agent local "SELECT name FROM views"
```

Locates `agent.db` at
`<sandbox>/Library/Application Support/com.agentwfy.mobile/agents/<agent>/agent.db`
and runs `sqlite3 -readonly`. The DB only exists after a profile has
connected at least once.

### `--logs`

```sh
./scripts/mobile-preview --logs iPhone-16-Pro          # tail -F build.log
./scripts/mobile-preview --logs iPhone-16-Pro -n 200   # snapshot last N lines
./scripts/mobile-preview --logs iPhone-16-Pro --device # simctl spawn … log stream
```

`--device` streams the simulator's `log` filtered to the app's subsystem and
process — this is where `eprintln!` from the Rust shell ends up, including
the debug bridge's `[debug-bridge] listening …` line.

## End-to-end smoke flow (`MOBILE_APP_PLAN.md` Step 1)

Walks the Step 1 verification: connect → snapshot → query → render view →
mutate daemon-side → confirm `db:changed` propagation.

### 1. Build and start a local daemon

```sh
./scripts/build-server

# Pick any directory as the agent root and bootstrap it. The init command
# prints a bearer token — save it for step 3.
node dist/server/index.js init /tmp/agentwfy-smoke-agent

AGENTWFY_AGENT_ROOT=/tmp/agentwfy-smoke-agent \
  node dist/server/index.js start
# Listens on ws://127.0.0.1:9878/api/v1/ws by default.
# Override port with AGENTWFY_REMOTE_PORT, bind host with AGENTWFY_REMOTE_HOST.
```

The daemon's own agent ID is the runtime-root path. The mobile-side `agentId`
is just a local namespace — anything consistent works.

### 2. Start the simulator preview

```sh
./scripts/mobile-preview                    # iPhone 16 Pro by default
```

### 3. Connect from inside the WebView

Either tap through the debug form in Simulator.app, or drive it from the host
with `--eval`:

```sh
./scripts/mobile-preview --eval iPhone-16-Pro "
  const f = document.getElementById('connect-form');
  f.querySelector('input[name=agentId]').value = 'smoke';
  f.querySelector('input[name=baseUrl]').value = 'http://127.0.0.1:9878';
  f.querySelector('input[name=agentToken]').value = '<TOKEN_FROM_STEP_1>';
  f.requestSubmit();
  'submitted'
"
```

The iOS Simulator shares the host's loopback for outbound TCP, so the
daemon at `127.0.0.1:9878` is reachable from inside the sim. On a real
device this URL must point at a host-reachable address (LAN IP, tunnel, or
HTTPS).

### 4. Verify the mirror caught up

```sh
./scripts/mobile-preview --eval iPhone-16-Pro \
  "document.getElementById('status-text').textContent"
# → "Backend: connected — Remote agent connected" or "Snapshot applied"

./scripts/mobile-preview --sqlite iPhone-16-Pro --agent smoke \
  "SELECT name FROM views ORDER BY name LIMIT 5"
# → home, system.docs, system.finder, …
```

### 5. Render a view

```sh
./scripts/mobile-preview --eval iPhone-16-Pro "
  document.querySelector('#view-form input[name=viewName]').value = 'home';
  document.querySelector('#view-form button[type=submit]').click();
  'submitted'
"
./scripts/mobile-preview --screenshot iPhone-16-Pro home-view.png
```

The iframe loads `agentview://localhost/view/home?tabId=mobile&rev=…`, served
by the Rust URI handler against the local SQLite mirror.

### 6. Confirm `db:changed` flow

Mutate the daemon-side DB from a separate WS client and watch the mobile
mirror absorb the change. The repo doesn't ship a daemon CLI mutate helper,
so use a one-off Node script — bind built-in `WebSocket` and call
`functions.invoke(runSql)`:

```sh
cat > /tmp/agentwfy-ws-mutate.mjs <<'EOF'
const token = process.env.AGENTWFY_TOKEN
const url = `ws://127.0.0.1:9878/api/v1/ws?token=${encodeURIComponent(token)}`
const sql = process.argv[2]
const ws = new WebSocket(url)
const id = 'mutate-' + Date.now()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'hello') {
    ws.send(JSON.stringify({ type: 'rpc', id, method: 'functions.invoke',
      params: { name: 'runSql', params: { target: 'agent', sql, params: [] } } }))
  } else if (msg.type === 'rpc:result' && msg.id === id) {
    console.log(JSON.stringify({ ok: msg.ok, value: msg.value, error: msg.error }, null, 2))
    ws.close(); process.exit(msg.ok ? 0 : 1)
  }
})
ws.addEventListener('error', (e) => { console.error('ws:', e.message); process.exit(1) })
setTimeout(() => { console.error('timeout'); process.exit(1) }, 10_000)
EOF

AGENTWFY_TOKEN=<TOKEN> node /tmp/agentwfy-ws-mutate.mjs \
  "INSERT INTO docs(name, content) VALUES('smoke-test', 'hello at ' || datetime('now'))"

./scripts/mobile-preview --sqlite iPhone-16-Pro --agent smoke \
  "SELECT name FROM docs WHERE name = 'smoke-test'"
# → smoke-test
```

Done when all six steps pass on a clean simulator.

### Real-device caveat

The harness only drives the iOS simulator. To test on a physical device, run
the daemon on a host-reachable address (LAN IP or tunnel), `tauri ios dev`
straight to the device, and grant the Local Network permission prompt on
first launch. Device automation is on the deferred list in
[`MOBILE_APP_PLAN.md`](../MOBILE_APP_PLAN.md) Step 8.

## Gotchas

- **`--restart` does a full rebuild + reinstall.** Cargo's incremental cache
  helps but the link step still takes seconds. There's no in-place HMR.
- **State directory is per simulator, not per worktree.** Switching worktrees
  while a preview is running gives you the previous worktree's build until
  you `--restart`.
- **The debug bridge is debug-only.** `cfg(debug_assertions)` strips it from
  release builds. If `--eval` reports "socket not found", confirm you built
  with `--debug` (the harness does, but worth knowing).
- **`Info.plist` declares `NSLocalNetworkUsageDescription`.** Required for
  Tauri's IPC server on iOS — without it the WebView load can fail with a
  cryptic local-network error.
