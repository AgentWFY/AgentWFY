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

## Smoke checklist (`MOBILE_APP_PLAN.md` Step 1)

```sh
# 1. Start the preview (sim + build + install + launch)
./scripts/mobile-preview

# 2. Confirm the WebView loaded (defensive — the app should be visible in
#    Simulator.app, but it's worth proving from the harness too).
./scripts/mobile-preview --eval iPhone-16-Pro "document.title"
./scripts/mobile-preview --screenshot iPhone-16-Pro initial.png

# 3. In the sim's debug UI: enter daemon URL + agent ID + token, tap Connect.
#    Then verify the mirror caught up:
./scripts/mobile-preview --sqlite iPhone-16-Pro --agent local \
  "SELECT name FROM views LIMIT 5"

# 4. Mutate something on the daemon side, then re-query to confirm db:changed flowed
./scripts/mobile-preview --sqlite iPhone-16-Pro --agent local \
  "SELECT COUNT(*) FROM views"
```

A non-localhost path (LAN IP or tunnel) needs a real iOS device, which this
harness does not yet drive — keep that step manual until device support
lands.

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
