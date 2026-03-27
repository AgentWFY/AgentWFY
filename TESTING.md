# Testing Infrastructure

How to run, interact with, and test the AgentWFY Electron app programmatically.

## Setup

Start the app once in the background with CDP enabled:

```bash
npm run dev -- --remote-debugging-port=9223 &
node scripts/cdp.mjs wait
```

The `wait` command blocks until the app is fully loaded and CDP is ready. Using `npm run dev` because dev.sh automatically respawns Electron on restart.

## After Editing Code

Rebuild and restart:

```bash
node scripts/build.mjs && node scripts/cdp.mjs restart
```

This rebuilds all entry points (without wiping dist — safe while esbuild watch is running), then restarts the app and waits until the new instance is ready.

For renderer-only changes (no restart needed):

```bash
node scripts/cdp.mjs eval "window.ipc.reloadRenderer()"
```

Humans can also press Cmd+Shift+Option+R (restart) or Cmd+Shift+R (reload renderer) in the app.

**Important**: Do not use `npm run build` while `npm run dev` is running — it does `rm -rf dist` which breaks the esbuild watch. Use `node scripts/build.mjs` instead, which overwrites files in place.

## Stopping the App

```bash
node scripts/cdp.mjs stop
```

## Interacting with the App

Everything goes through `scripts/cdp.mjs` which talks to the app via Chrome DevTools Protocol.

```bash
node scripts/cdp.mjs screenshot /tmp/app.png             # Screenshot main page
node scripts/cdp.mjs screenshot-target <id> /tmp/x.png   # Screenshot specific target
node scripts/cdp.mjs eval "document.title"                # Evaluate JS in main page
node scripts/cdp.mjs eval-target <id> "document.title"   # Evaluate JS in specific target
node scripts/cdp.mjs dom                                  # DOM element summary
node scripts/cdp.mjs targets                              # List all CDP targets
node scripts/cdp.mjs tabs                                 # List open tabs
node scripts/cdp.mjs open-tab 2                           # Open view by ID
node scripts/cdp.mjs open-tab "https://example.com"       # Open URL tab
node scripts/cdp.mjs close-tab <tabId>                    # Close a tab
node scripts/cdp.mjs console                              # Stream console messages
node scripts/cdp.mjs ipc "sql.run" '[{"sql":"SELECT name FROM views"}]'
node scripts/cdp.mjs logs                                 # Show Electron main process logs
node scripts/cdp.mjs logs 100                              # Last 100 lines
node scripts/cdp.mjs restart                              # Restart app + wait until ready
node scripts/cdp.mjs stop                                 # Stop app and dev.sh
node scripts/cdp.mjs wait                                 # Wait until app is ready
node scripts/cdp.mjs test                                 # Full connection test
```

Set `CDP_PORT` env var if using a different port (default: 9223).

### Inspecting other targets

The app uses a single main window. Agent view tabs (rendered as WebContentsViews) and floating child windows (command palette, confirmation dialog) appear as separate CDP targets. Use `targets` to list them, then `screenshot-target` or `eval-target` to interact:

```bash
node scripts/cdp.mjs targets

# Example output:
#   [page] "AgentWFY" @ app://index.html/
#   [page] "" @ agentview://...view/16?...
#   [page] "Command Palette" @ file:///.../command_palette.html

node scripts/cdp.mjs screenshot-target <id> /tmp/palette.png
node scripts/cdp.mjs eval-target <id> "document.querySelector('input').value"
```

Agent view tabs and URL tabs are always present while open. The command palette only appears as a target while it's open — open it first with `cdp.mjs eval "window.ipc.commandPalette.show()"`.

## IPC API

The main page exposes `window.ipc`. Call via `cdp.mjs eval` or `cdp.mjs ipc`:

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
window.ipc.restart()                              // Exit app (dev.sh respawns)
window.ipc.stop()                                 // Exit app and dev.sh
window.ipc.reloadRenderer()                       // Reload renderer

// Files, plugins, providers, tasks
window.ipc.files.read('path')
window.ipc.plugins.methods()
window.ipc.providers.list()
window.ipc.tasks.listRunning()
```

## Multiple Instances

Each instance needs a unique CDP port. Useful for parallel worktrees:

```bash
npm run dev -- --remote-debugging-port=9224 &
CDP_PORT=9224 node scripts/cdp.mjs wait
CDP_PORT=9224 node scripts/cdp.mjs screenshot /tmp/app.png
```

## macOS Screen Control (`scripts/macos-control.sh`)

For the rare cases where you need to interact with native macOS UI that is not a CDP target (system file picker dialogs, macOS menu bar, Dock):

```bash
bash scripts/macos-control.sh screenshot-app Electron /tmp/app.png
bash scripts/macos-control.sh click 500 300
bash scripts/macos-control.sh type "hello"
bash scripts/macos-control.sh key k command
bash scripts/macos-control.sh list-windows Electron
bash scripts/macos-control.sh menu Electron File "Open Agent…"
```

## Troubleshooting

### Port already in use

```bash
lsof -i :9223
npm run dev -- --remote-debugging-port=9333 &
CDP_PORT=9333 node scripts/cdp.mjs wait
```

### App doesn't reflect code changes

Rebuild and restart:

```bash
node scripts/build.mjs && node scripts/cdp.mjs restart
```

### Wrong window in screenshot

```bash
node scripts/cdp.mjs targets
node scripts/cdp.mjs screenshot-target <id> /tmp/specific.png
```
