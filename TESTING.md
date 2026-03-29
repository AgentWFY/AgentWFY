# Testing Infrastructure

How to run, interact with, and test the AgentWFY Electron app programmatically.

## Setup

Build and start the app in the background with CDP enabled:

```bash
./scripts/build
./scripts/start --remote-debugging-port=9223 &
./scripts/cdp wait
```

The `wait` command blocks until the app is fully loaded and CDP is ready. `scripts/start` automatically respawns Electron on restart (exit code 100).

## After Editing Code

Rebuild and restart:

```bash
./scripts/build && ./scripts/cdp restart
```

This rebuilds all source files, then restarts the app and waits until the new instance is ready.

For renderer-only changes (no restart needed):

```bash
./scripts/cdp eval "window.ipc.reloadRenderer()"
```

Humans can also press Cmd+Shift+Option+R (rebuild + restart) or Cmd+Shift+R (rebuild + reload renderer) in the app.

**Important**: The in-app reload (Cmd+Shift+R) runs only the TypeScript compiler (tsgo), not the full build. Use `./scripts/build` from the terminal for a full clean build including static assets and system data.

## Stopping the App

```bash
./scripts/cdp stop
```

## Interacting with the App

Everything goes through `scripts/cdp` which talks to the app via Chrome DevTools Protocol.

```bash
./scripts/cdp screenshot /tmp/app.png             # Screenshot main page
./scripts/cdp screenshot-target <id> /tmp/x.png   # Screenshot specific target
./scripts/cdp eval "document.title"                # Evaluate JS in main page
./scripts/cdp eval-target <id> "document.title"   # Evaluate JS in specific target
./scripts/cdp dom                                  # DOM element summary
./scripts/cdp targets                              # List all CDP targets
./scripts/cdp tabs                                 # List open tabs
./scripts/cdp open-tab 2                           # Open view by ID
./scripts/cdp open-tab "https://example.com"       # Open URL tab
./scripts/cdp close-tab <tabId>                    # Close a tab
./scripts/cdp console                              # Stream console messages
./scripts/cdp ipc "sql.run" '[{"sql":"SELECT name FROM views"}]'
./scripts/cdp logs                                 # Show Electron main process logs
./scripts/cdp logs 100                              # Last 100 lines
./scripts/cdp restart                              # Restart app + wait until ready
./scripts/cdp stop                                 # Stop app
./scripts/cdp wait                                 # Wait until app is ready
./scripts/cdp test                                 # Full connection test
```

Set `CDP_PORT` env var if using a different port (default: 9223).

### Inspecting other targets

The app uses a single main window. Agent view tabs (rendered as WebContentsViews) and floating child windows (command palette, confirmation dialog) appear as separate CDP targets. Use `targets` to list them, then `screenshot-target` or `eval-target` to interact:

```bash
./scripts/cdp targets

# Example output:
#   [page] "AgentWFY" @ app://index.html/
#   [page] "" @ agentview://...view/16?...
#   [page] "Command Palette" @ file:///.../command_palette.html

./scripts/cdp screenshot-target <id> /tmp/palette.png
./scripts/cdp eval-target <id> "document.querySelector('input').value"
```

Agent view tabs and URL tabs are always present while open. The command palette only appears as a target while it's open — open it first with `cdp eval "window.ipc.commandPalette.show()"`.

## IPC API

The main page exposes `window.ipc`. Call via `cdp eval` or `cdp ipc`:

```javascript
// SQL
window.ipc.sql.run({ sql: 'SELECT * FROM views', params: [] })

// Tabs
window.ipc.tabs.getTabState()
window.ipc.tabs.openTab({ url: 'https://...' })
window.ipc.tabs.openTab({ viewId: 16 })
window.ipc.tabs.closeTab({ tabId: '...' })
window.ipc.tabs.captureTab({ tabId: '...' })      // → base64 PNG
window.ipc.tabs.getConsoleLogs({ tabId: '...' })
window.ipc.tabs.execJs({ tabId: '...', code: 'document.title' })

// Command palette
window.ipc.commandPalette.show()
window.ipc.commandPalette.showFiltered('query')

// Agent sessions
window.ipc.agent.createSession({ prompt: '...' })
window.ipc.agent.sendMessage('Hello')
window.ipc.agent.getSnapshot()

// Agent sidebar (switch between agents in single window)
window.ipc.agentSidebar.getInstalled()            // List loaded agents
window.ipc.agentSidebar.switch('/path/to/agent')  // Switch or add agent
window.ipc.agentSidebar.add()                     // Open agent picker dialog

// App control
window.ipc.restart()                              // Rebuild + restart (start.mjs respawns)
window.ipc.stop()                                 // Stop app
window.ipc.reloadRenderer()                       // Rebuild + reload all windows

// Files, plugins, providers, tasks
window.ipc.files.read('path')
window.ipc.plugins.methods()
window.ipc.providers.list()
window.ipc.tasks.listRunning()
```

## Multiple Instances

When testing a feature branch in a worktree, you can run a second app instance alongside the main one. `scripts/start` automatically detects worktrees and isolates the instance — just use a different CDP port:

```bash
# From your worktree directory:
./scripts/build
./scripts/start --remote-debugging-port=9224 &
./scripts/cdp wait   # waits on default port (9223), use CDP_PORT=9224 for the worktree instance
```

**How it works:** In a git worktree, `scripts/start` auto-sets `AGENTWFY_APP_ID=AgentWFY-{worktree-name}`, which gives the instance its own `userData` directory (e.g. `~/Library/Application Support/AgentWFY-flickering-gliding-stardust/`). The main repo is unaffected. You can override this with `AGENTWFY_APP_ID=custom-name ./scripts/start ...` if needed.

Interact with the worktree instance by setting `CDP_PORT`:

```bash
CDP_PORT=9224 ./scripts/cdp screenshot /tmp/app.png
CDP_PORT=9224 ./scripts/cdp eval "document.title"
CDP_PORT=9224 ./scripts/cdp stop
```

**What is isolated vs shared:**

| Resource | Isolated? | Notes |
|----------|-----------|-------|
| Global config (`config.json`) | Yes | Worktree instance has its own — agent list starts empty |
| Chromium state (GPU cache, cookies) | Yes | Separate `userData` directory |
| HTTP API port | Yes | Falls back to OS-assigned port if 9877 is taken |
| Agent data (`.agentwfy/`) | Yes | As long as instances use different agent directories |
| macOS menu bar label | Yes | Shows worktree name — easy to tell instances apart |

**Cleanup** — remove the worktree's userData when done:

```bash
rm -rf ~/Library/Application\ Support/AgentWFY-*/   # all worktree instances
```

This is mostly Chromium cache (~100-200 MB). Agent data lives in the agent directory and is unaffected.

## macOS Screen Control (`scripts/macos-control`)

For the rare cases where you need to interact with native macOS UI that is not a CDP target (system file picker dialogs, macOS menu bar, Dock):

```bash
./scripts/macos-control screenshot-app Electron /tmp/app.png
./scripts/macos-control click 500 300
./scripts/macos-control type "hello"
./scripts/macos-control key k command
./scripts/macos-control list-windows Electron
./scripts/macos-control menu Electron File "Open Agent…"
```

## Troubleshooting

### Port already in use

```bash
lsof -i :9223
./scripts/start --remote-debugging-port=9333 &
CDP_PORT=9333 ./scripts/cdp wait
```

### App doesn't reflect code changes

Rebuild and restart:

```bash
./scripts/build && ./scripts/cdp restart
```

### Wrong window in screenshot

```bash
./scripts/cdp targets
./scripts/cdp screenshot-target <id> /tmp/specific.png
```
