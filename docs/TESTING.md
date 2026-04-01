# Testing Guide

How to test the AgentWFY app through its UI. Read this before testing. Update this doc when you discover something that will make future testing faster or more reliable — corrected selectors, timing quirks, non-obvious gotchas. Don't add noise.

For CDP tool reference (API signatures, commands, output format), see [CDP.md](CDP.md).

## Setup

```bash
./scripts/build
./scripts/cdp start              # headless, isolated instance
# After code changes:
./scripts/build && ./scripts/cdp restart
# When done:
./scripts/cdp stop
```

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

Shadow DOM components: `awfy-agent-sidebar`, `awfy-task-panel`, `awfy-status-line`. CDP primitives (`click`, `getText`, etc.) traverse shadow roots automatically. But `eval()` JS needs explicit `.shadowRoot` access.

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

### Command Palette (separate CDP target)

Not in main page DOM. Opens as a child window.

```js
await press("Meta+k");
await sleep(300);
const t = await targets();
const p = t.find(t => t.title === "Command Palette");
await typeTarget(p.id, "query");
await clickTarget(p.id, ".item:first-child");
await pressTarget(p.id, "Escape"); // close
```

Disappears from targets when closed.

## Flows

### Send a chat message

```js
await click("textarea#msg-input");
await type("Hello!");
await press("Enter");
await waitFor(".assistant-text");
```

### Switch sidebar panels

```js
await click('.awfy-app-sidebar-switcher-btn[data-panel="tasks"]');
await waitFor("awfy-task-panel");
```

### Toggle sidebar

```js
await click(".awfy-app-sidebar-toggle");       // close
await click(".awfy-app-inline-toggle");         // reopen
```

### Close active tab

```js
await click(".tab-item.active .tab-close");
```

### Run a task

```js
await click('.awfy-app-sidebar-switcher-btn[data-panel="tasks"]');
await click('.tab[data-tab="tasks"]');
await click('.task-card[data-task-name="my-task"]');
await click('.tc-run[data-run-task="my-task"]');
await click('.tab[data-tab="runs"]');
await waitFor(".rr-pulse");
```

### Select a provider

```js
await click('.provider-card[data-provider-id="openai-compatible"]');
```

### Check streaming state

```js
const isStreaming = await eval('document.querySelector(".stop-btn")?.style.display !== "none"');
```

## Testing Tips

<!-- Add findings here that will make future testing faster or more reliable. -->

### Headless mode limitations

- Command palette `BrowserWindow` is never shown/hidden visually in headless mode (`AGENTWFY_HEADLESS=1`). `isVisible()` is always false, so `toggle()` always calls `show()`. The blur handler and race conditions between blur/toggle cannot be tested headlessly — use `--visible` for those.
- The palette target persists in the CDP target list even after closing (window is hidden, not destroyed). Check item count or search input instead of target presence to verify open/close state.

### Plugin installation without file dialog

Insert directly into the agent's `agent.db` via the `sqlite3` CLI (bypasses the app's TEMP write-guard triggers since it's a separate connection), then restart:

```bash
AGENT_ROOT=$(CDP_PORT=... ./scripts/cdp run 'return await eval("window.ipc.getAgentRoot()")' | jq -r .data)
sqlite3 "$AGENT_ROOT/.agentwfy/agent.db" "INSERT INTO plugins (name, title, description, version, code, enabled, created_at, updated_at) VALUES ('my-plugin', 'My Plugin', '', '1.0.0', 'module.exports = { activate(api) { ... } }', 1, unixepoch(), unixepoch());"
./scripts/cdp restart
```

### Session close button needs hover

`.session-item-close` is `display: none` by default, only visible on CSS `:hover`. CDP click still works because it resolves coordinates via deep query, but `getRect` will fail (zero size). Use `eval` to force `display: flex` first, or close sessions via IPC (`window.ipc.agent.closeSession()`).

### Test provider setup

A minimal echo provider can be installed as a plugin. It echoes back "Echo: {input}" with character-by-character streaming. See the plugin installation tip above for how to insert it. After inserting, restart the app and click `.provider-card[data-provider-id="test-provider"]` to select it.
