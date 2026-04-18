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

**After code changes:** restart the app. It rebuilds from the mounted source automatically.

```bash
./scripts/preview --restart my-feature    # name = directory name of the worktree
```

VNC reconnects in a few seconds after rebuild.

## Driving the preview programmatically

The preview publishes two host ports: noVNC (visual) and the Electron app's Chrome DevTools Protocol (CDP). Start output prints both. The main renderer (`app://index.html/`) exposes `window.ipc` with the full IPC surface; each tab is a separate `agentview://` CDP target with its own DOM.

You rarely need a CDP client of your own — `./scripts/preview --eval` runs expressions for you. The raw CDP endpoints are still there if you want them.

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
# Includes a 500ms settle so tab switches / bounds changes land before capture.
./scripts/preview --screenshot <name> out.png

# SQL against the running agent DB — for seeding views, triggers, config
./scripts/preview --sqlite <name> "SELECT name FROM views"
./scripts/preview --sqlite <name> "INSERT OR REPLACE INTO config (name, value) VALUES ('system.default-view', 'my-view')"

# Raw docker exec into the container
./scripts/preview --exec <name> bash -c '...'
```

The container ships `sqlite3`, `grim`, `jq`, `curl`, and Node — agent-side scripting needs no host deps.

### After changing tab state, wait a beat before screenshotting

`selectTab` and `openTab` push state to the renderer, which then IPC's bounds back through the main process — the grim compositor sample lags that round-trip. `--screenshot` already settles for 500ms; if you're still seeing the previous tab, add another `sleep 0.5` or poll the DOM via `--eval --tab <target>` until the expected content appears.

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
| Stop streaming | `.stop-btn` (display:none when idle) |

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
| Session item | `.session-item` |
| Active session | `.session-item.active` |
| Streaming | `.session-item.streaming` |
| Close session | `.session-item-close` (visible on hover) |
| New session | `.gear-btn[title="New session"]` |
| All sessions | `.gear-btn[title="All sessions"]` |
| Settings | `.gear-btn[title="Settings"]` |

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

### Session close button needs hover

`.session-item-close` is `display: none` by default, only visible on CSS `:hover`. Hover the session row before clicking, or close sessions via CDP (`window.ipc.agent.closeSession()`).

### Hidden-tab repro needs full-viewport body

When inserting test views that use `openTab({ hidden: true })` to exercise tab stacking, make both the selected and hidden view bodies cover the full viewport (`html,body { height:100%; margin:0 }` + a colored background). A body that only wraps its text leaves the WebContentsView's own opaque background color showing, which is indistinguishable from a correctly-occluded hidden tab — the repro becomes unfalsifiable.

### Test provider setup

A minimal echo provider can be installed as a plugin. It echoes back "Echo: {input}" with character-by-character streaming. See the plugin installation tip above for how to insert it. After inserting, restart the app and click `.provider-card[data-provider-id="test-provider"]` to select it.
