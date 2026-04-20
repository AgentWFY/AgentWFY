# Testing Guide

How to test the AgentWFY app through its UI. Read this before testing. Update this doc when you discover something that will make future testing faster or more reliable — corrected selectors, timing quirks, non-obvious gotchas. Don't add noise.

## Setup

Testing runs the app in Docker with VNC — connect to the URL it prints with a browser or any VNC client. Source is mounted, so code changes are picked up on app restart. Works with any worktree.

```bash
# Start preview (waits until the app is serving CDP before returning)
./scripts/preview                                    # current directory
./scripts/preview ~/projects/agentwfy/.claude/worktrees/my-feature
./scripts/preview <worktree> --agent ~/my-agent      # with existing agent data

# Manage previews
./scripts/preview --list                             # running previews
./scripts/preview --stop my-feature                  # stop one (name = directory name)
./scripts/preview --stop                             # stop all
```

First run on a machine pulls/builds the ~1GB base image and can take 5-10 minutes; subsequent runs reuse the cache.

**Always start a fresh preview for each test run** — `./scripts/preview` from the worktree you want to test. Attaching to a preview that was started earlier (from this worktree or another) means you're running whatever image was current when it was started, not the current source. Preview subcommands warn when they detect this, but the safest default is to stop any existing preview and start again.

**After code changes:** restart the app. It rebuilds from the mounted source automatically.

```bash
./scripts/preview --restart my-feature    # name = directory name of the worktree
```

VNC reconnects in a few seconds after rebuild.

## Driving the preview programmatically

The preview publishes two host ports: noVNC (visual) and the Electron app's Chrome DevTools Protocol (CDP). Start output prints both. The main renderer (`app://index.html/`) exposes `window.ipc` with the full IPC surface; each tab is a separate `agentview://` CDP target with its own DOM.

You rarely need a CDP client of your own — `./scripts/preview --eval` runs expressions for you. The raw CDP endpoints are still there if you want them.

### System views available for testing

Every fresh install ships with these views. Pick visually distinct ones for stacking / occlusion / tab-switch tests:

| View | Notes |
|------|-------|
| `home` | Initial tab on a fresh preview. Full-viewport background. |
| `system.source-explorer` | File tree + content pane. Distinct layout. |
| `system.docs` | Markdown doc list. |
| `system.plugins` | Plugin manager page. |
| `system.openai-compatible-provider.settings-view` | Provider settings. |

`openTab({ viewName: 'does-not-exist' })` rejects with `View not found`. `./scripts/preview --sqlite <name> "SELECT name FROM views"` enumerates whatever's actually installed (plugins can register more).

A handy "reset to a clean tab state" snippet:

```bash
./scripts/preview --eval <name> "
(async () => {
  const s = await window.ipc.tabs.getTabState();
  for (const t of s.tabs) { if (t.target !== 'home') await window.ipc.tabs.closeTab({ tabId: t.id }); }
})()
"
```

Partial failures in `openTab` (e.g. a non-existent view mid-sequence) still create the tabs that *did* succeed — always reset between runs.

### The everyday helper: `--eval`

`--eval` runs an expression against the app's main renderer by default, awaits the returned promise, and prints the JSON result on stdout. Use `--tab <url-fragment>` to target a specific WebContentsView tab instead.

```bash
# State of all tabs (runs in main renderer — window.ipc is available)
./scripts/preview --eval <name> "await window.ipc.tabs.getTabState()"

# Open a view as a tab
./scripts/preview --eval <name> "window.ipc.tabs.openTab({ viewName: 'system.source-explorer' })"

# Open as a hidden background tab
./scripts/preview --eval <name> "window.ipc.tabs.openTab({ viewName: 'system.docs', hidden: true })"

# Select a tab by id (ids come from getTabState)
./scripts/preview --eval <name> "window.ipc.tabs.selectTab({ tabId: 'abc123' })"

# Inspect the DOM of a specific tab — --tab matches the tab's URL substring
./scripts/preview --eval <name> --tab system.source-explorer \
  "Array.from(document.querySelectorAll('.item .item-name')).map(n => n.textContent.trim())"

# Fire a click inside a tab
./scripts/preview --eval <name> --tab system.source-explorer \
  "document.querySelector('.tab-btn[data-tab=\"views\"]').click(); null"
```

Return `null` from side-effecting expressions (Runtime.evaluate can't serialize `undefined`). The helper wraps everything as if prefixed with `await`, so async IPC calls work directly.

For multi-statement snippets (`const x = ...; ...`), wrap in an IIFE — statements aren't expressions and return `null` otherwise: `"(() => { const x = ...; return {...}; })()"`.

### Raw CDP

```bash
./scripts/preview --cdp <name>              # print CDP base URL and /json URL

# List targets (main renderer + each WebContentsView tab)
curl -s http://localhost:<cdp>/json | jq '.[] | {title, url, id}'

# Just the main renderer target
curl -s http://localhost:<cdp>/json | jq '.[] | select(.url|startswith("app://"))'
```

Each target's `webSocketDebuggerUrl` in `/json` is a WebSocket endpoint you can drive with any CDP client. The in-container proxy rewrites those URLs to point back through the published port, so they work from the host as-is.

### Screenshots, SQL, escape hatch

```bash
# Composited screenshot via grim (captures WebContentsView layers — CDP screenshots don't).
# Default 500ms settle so tab switches / bounds changes land before capture.
./scripts/preview --screenshot <name> out.png

# Skip the settle to capture mid-transition frames (see "Catching transient state" below).
./scripts/preview --screenshot <name> --no-settle out.png

# SQL against the running agent DB — for seeding views, triggers, config
./scripts/preview --sqlite <name> "SELECT name FROM views"
./scripts/preview --sqlite <name> "INSERT OR REPLACE INTO config (name, value) VALUES ('system.default-view', 'my-view')"

# Raw docker exec into the container
./scripts/preview --exec <name> bash -c '...'
```

The container ships `sqlite3`, `grim`, `jq`, `curl`, and Node — agent-side scripting needs no host deps.

### Diagnostics

```bash
# Tail main-process logs (stdout + stderr, written to /app/.dev.log).
# This streams — Ctrl+C to stop. Add `-n N` for a one-shot snapshot.
./scripts/preview --logs <name>
./scripts/preview --logs <name> -n 50

# Stream the main renderer's console.* output over CDP (Ctrl+C to stop).
./scripts/preview --logs <name> --renderer

# Main-process tab state: per-tab bounds, z-index, visible flag,
# selectedTabId, contentView children count. Use this when a screenshot
# doesn't match the tab state you expect.
./scripts/preview --inspect tabs <name>
```

`visible: true` in the `--inspect tabs` output just means `WebContentsView.setVisible(true)` — a tab with `bounds: {0,0,0,0}` is fully collapsed and draws nothing, but still reports visible. Trust the bounds first.

**`window.ipc.tabs.describe()` is the bounds/z-order authority.** For occlusion, tab-close, or "wrong tab is visible" bugs, it reports per-tab `bounds`, `zIndex`, `visible`, and `isSelected` straight from `BaseWindow.contentView.children` — the single source of truth for what the compositor will actually draw. `getTabState()` only reports the logical tab list; it doesn't see z-order. `--inspect tabs` is a thin wrapper around `describe`. Prefer it when debugging any visibility mismatch.

### Catching transient state (race-condition repros)

Some bugs live in the window between a handler returning and the renderer reacting. To catch that state:

- **Pipeline IPC calls in one `--eval`.** Fire the trigger and the inspector as parallel promises — they arrive on main in IPC order, so the inspector reads main-state the moment the handler returns, before the renderer's ResizeObserver / rAF cycle can paper over it:
  ```js
  const trigger = window.ipc.tabs.closeTab({ tabId });
  const snap = window.ipc.tabs.describe();
  await trigger;
  return await snap;   // main-state immediately post-handler
  ```
  Awaiting `closeTab` first and then calling `describe` gives the renderer a full round-trip to fix the state up; pipelining as above does not.
- **`--screenshot --no-settle`** captures the compositor frame without the 500ms settle — useful when the race is long enough to be visible. Pair with a `sleep`-offset wrapper if you need a specific delay into the transition.
- **Renderer-side races are different.** If the race lives in the renderer (not main), block the renderer's event loop after the trigger by looping `while (Date.now() - t0 < N) {}` in the same `--eval` expression, then inspect via a second `--eval` call.

### After changing tab state, wait a beat before screenshotting

`selectTab` and `openTab` push state to the renderer, which then IPC's bounds back through the main process — the grim compositor sample lags that round-trip. `--screenshot` already settles for 500ms; if you're still seeing the previous tab, add another `sleep 0.5` or poll the DOM via `--eval --tab <target>` until the expected content appears.

### Preview vs real desktop

The preview runs Electron headless against a wayvnc compositor — close to the real app but not identical. A few things to know when a test behaves strangely:

- **rAF isn't throttled.** The preview launches Chromium with `--disable-renderer-backgrounding` and friends, so `requestAnimationFrame` fires at normal cadence even though there's no visible OS-level window. If you find yourself writing code that works around rAF being suspended, you're fighting a bug — file it.
- **`window.ipc` is frozen.** `contextBridge.exposeInMainWorld` produces a non-writable object. You can't monkey-patch `window.ipc.tabs.*` from `--eval` to observe calls — the assignment silently no-ops. Use `--logs --renderer` to see renderer `console.log` output, or add temporary `window.__probe = []; window.__probe.push(...)` scaffolding in the source if you need a side channel.
- **Renderer logs don't land in `/app/.dev.log`.** That file only captures main-process stdout/stderr. For renderer diagnostics use `--logs --renderer` (streams `Runtime.consoleAPICalled` over CDP).
- **Main-process state is authoritative for tab geometry.** The renderer tells the main process what bounds tabs should have; `--eval` only sees the renderer's view. When the screenshot disagrees with `window.ipc.tabs.getTabState()`, run `--inspect tabs` — it dumps per-tab `bounds`, `zIndex`, `visible` straight from the main process's BaseWindow children.

## App Layout

```
awfy-app
└─ .awfy-app-root
   ├─ .awfy-app-body
   │  ├─ <awfy-agent-sidebar>          78px, Shadow DOM, agent list
   │  ├─ .awfy-app-sidebar             380px, resizable
   │  │  ├─ .awfy-app-sidebar-top      toggle button + Chat/Tasks switcher
   │  │  ├─ <awfy-agent-chat>          chat panel (or .panel-hidden)
   │  │  └─ <awfy-task-panel>          task panel (or .panel-hidden), Shadow DOM
   │  ├─ .awfy-app-resize-handle       4px drag handle
   │  └─ .awfy-app-main-column
   │     ├─ .awfy-app-header           tab bar + inline toggle
   │     │  └─ <awfy-tabs>
   │     └─ .awfy-app-main-area        WebContentsView tab content
   └─ <awfy-status-line>               24px footer, Shadow DOM
```

Shadow DOM components: `awfy-agent-sidebar`, `awfy-task-panel`, `awfy-status-line`. Clicking visible elements traverses shadow roots automatically; direct JS access needs explicit `.shadowRoot` traversal.

## Selectors

### Sidebar Header

| Element | Selector |
|---------|----------|
| Toggle sidebar | `.awfy-app-sidebar-toggle` |
| Chat button | `.awfy-app-sidebar-switcher-btn[data-panel="agent-chat"]` |
| Tasks button | `.awfy-app-sidebar-switcher-btn[data-panel="tasks"]` |
| Reopen sidebar (when closed) | `.awfy-app-inline-toggle` |

Active button: `.active` class. Hidden panel: `.panel-hidden` class.

### Agent Sidebar (Shadow DOM)

| Element | Selector |
|---------|----------|
| Agent item | `.agent-item` |
| Active agent | `.agent-item-wrapper.active` |
| Add agent | `.add-btn` |

### Chat Panel

**Input:**

| Element | Selector |
|---------|----------|
| Text input | `textarea#msg-input` |
| Stop streaming | `.composer-stop` (display:none when idle) |
| Status line | `.composer-status` (click to open provider panel) |

Enter sends. Shift+Enter for newline.

**Messages:**

| Element | Selector |
|---------|----------|
| Container | `.messages` |
| User message | `.block-user` |
| Assistant text | `.assistant-text` |
| Thinking text | `.thinking-text` |
| Tool card | `.tool-card` |
| Tool header (click to toggle) | `.tool-header` |
| Error banner | `.error-banner` |
| Retry banner | `.retry-banner` |
| Scroll to bottom | `.scroll-to-bottom` |

**Providers (shown when no session):**

| Element | Selector |
|---------|----------|
| Provider card | `.provider-card[data-provider-id="..."]` |
| Settings button | `.provider-card-settings-btn` |
| Set default | `.set-default-btn[data-provider-id="..."]` |
| Add provider | `[data-action="browse-providers"]` |

Selected: `.provider-card.selected`.

**Sessions:**

| Element | Selector |
|---------|----------|
| Session tab | `.awfy-st-tab` (pill-shaped, in composer top strip) |
| Active session | `.awfy-st-tab.active` (bolder border + expanded label) |
| Streaming dot | `.awfy-st-dot.streaming` (pulsing blue) |
| Collapsed tab | `.awfy-st-tab.collapsed` (20×20 dot box when >2 sessions) |
| Close session | middle-click or right-click on `.awfy-st-tab` |
| New session | `.awfy-st-new` (+ button in strip) |
| All sessions | `.icon-btn[title="All sessions"]` |
| Settings | `.icon-btn[title="Settings"]` |
| Attach | `.icon-btn[title="Attach image"]` |
| Notify | `.icon-btn[title="Notify when finished"]` |

**Retry/Error:**

| Element | Selector |
|---------|----------|
| Retry now | `button[data-action="retry-now"]` |
| Stop retry | `button[data-action="stop-retry"]` |

### Task Panel (Shadow DOM)

**Tabs:**

| Element | Selector |
|---------|----------|
| Runs | `.tab[data-tab="runs"]` |
| Tasks | `.tab[data-tab="tasks"]` |
| Triggers | `.tab[data-tab="triggers"]` |

Active: `.tab.active`.

**Runs:**

| Element | Selector |
|---------|----------|
| Running row | `.rr[data-detail-run="<runId>"]` |
| Running dot | `.rr-pulse` |
| Stop | `.rr-stop[data-stop-run="<runId>"]` |
| History row | `.hr[data-detail-file="<logFile>"]` |
| Status dot | `.hr-dot.ok` / `.hr-dot.err` |

**Tasks:**

| Element | Selector |
|---------|----------|
| Task card | `.task-card[data-task-name="<name>"]` |
| Run button | `.tc-run[data-run-task="<name>"]` |
| Input field | `.run-input[data-input-task="<name>"]` |
| Run with input | `.run-input-btn[data-run-task-input="<name>"]` |

Expanded: `.task-card.expanded`.

**Triggers:**

| Element | Selector |
|---------|----------|
| Trigger card | `.trig-card[data-trigger-name="<name>"]` |
| Toggle | `.trig-toggle[data-trigger-toggle="<name>"]` |

Disabled: `.trig-card.disabled`, `.trig-toggle.off`.

**Detail view:**

| Element | Selector |
|---------|----------|
| Back | `.d-back` |
| Stop | `[data-detail-stop]` |
| Copy logs | `[data-copy-logs]` |
| Auto-scroll | `[data-auto-scroll]` |
| Log output | `.d-log` |

### Tab Bar

| Element | Selector |
|---------|----------|
| Tab item | `.tab-item` |
| Active tab | `.tab-item.active` |
| Pinned tab | `.tab-item.pinned` |
| Close button | `.tab-close` |
| Hidden tabs toggle | `.hidden-tabs-btn` |
| Hidden tab item | `.hidden-tab-item` |

Middle-click closes tab (if not pinned). Right-click opens context menu. Draggable for reorder.

### Status Line (Shadow DOM)

| Element | Selector |
|---------|----------|
| Agent indicator | `#agent-indicator` |
| Task indicator | `#task-indicator` |
| Port info | `#port-info` |
| Backup info | `#backup-info` |
| Data dir | `#data-dir` |

### Command Palette

The command palette is a WebContentsView overlay inside the main window. Open with Ctrl+K (Linux) / Cmd+K (macOS).

### Zen Mode

Hides the agent sidebar, tab bar, main column, and status line; only the active chat sidebar remains. Triggered by the `toggle-zen-mode` shortcut action (default `Ctrl+.` / `Cmd+.`) or programmatically:

```js
await window.ipc.zenMode.set(true)   // enable
await window.ipc.zenMode.set(false)  // disable
await window.ipc.zenMode.toggle()
```

When zen is on, the root element gains the `zen-mode` class and every tab view's bounds collapse to `{0,0,0,0}`. `--inspect tabs` is the authoritative check: all tabs should have zero-sized bounds while zen is active.

## Testing Tips

<!-- Add findings here that will make future testing faster or more reliable. -->

### Preview mode tips

- The preview runs inside Docker with sway (Wayland compositor) + wayvnc + noVNC. The app runs at the compositor's resolution, scaled to fit the browser tab.
- Don't use in-app reload shortcuts (Ctrl+Shift+R etc.) — they cause layout issues. Instead close the app to trigger a full rebuild.
- Source is mounted read-only at `/src`. The container copies it to `/app`, builds, and runs. Each restart picks up the latest code.
- Agent data is mounted read-write when using `--agent`. Changes persist.

### Plugin installation without file dialog

Insert directly into the agent's `agent.db` (bypasses the app's TEMP write-guard triggers — separate connection), then restart:

```bash
./scripts/preview --sqlite <name> "INSERT INTO plugins (name, title, description, version, code, enabled, created_at, updated_at) VALUES ('my-plugin', 'My Plugin', '', '1.0.0', 'module.exports = { activate(api) { ... } }', 1, unixepoch(), unixepoch())"
./scripts/preview --restart <name>
```

### Closing a session tab

There's no explicit close button. Middle-click (`button === 1`) or right-click a `.awfy-st-tab` to close it, or call `window.ipc.agent.closeSession()` via CDP for the active session.

### Hidden-tab repro needs full-viewport body

When inserting test views that use `openTab({ hidden: true })` to exercise tab stacking, make both the selected and hidden view bodies cover the full viewport (`html,body { height:100%; margin:0 }` + a colored background). A body that only wraps its text leaves the WebContentsView's own opaque background color showing, which is indistinguishable from a correctly-occluded hidden tab — the repro becomes unfalsifiable.

### Test provider setup

A minimal echo provider can be installed as a plugin. It echoes back "Echo: {input}" with character-by-character streaming. See the plugin installation tip above for how to insert it. After inserting, restart the app and click `.provider-card[data-provider-id="test-provider"]` to select it.
