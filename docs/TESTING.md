# Testing Infrastructure

How to run, interact with, and test the AgentWFY Electron app programmatically.

## Setup

Build and start an isolated test instance:

```bash
./scripts/build
./scripts/cdp start                    # headless, fresh default agent, auto-picks free port
./scripts/cdp start --visible          # show windows (watch tests run)
```

Prints the assigned port on success (e.g. `port: 57407`). Use `CDP_PORT=<port>` for all subsequent commands:

```bash
CDP_PORT=57407 ./scripts/cdp screenshot /tmp/app.png
CDP_PORT=57407 ./scripts/cdp press Meta+k
CDP_PORT=57407 ./scripts/cdp stop
```

Each `cdp start` creates a fully isolated instance with:
- Fresh default agent in a temp directory (no real agent data touched)
- Unique app ID (no collision with other instances or the real app)
- Temp global config (tests don't affect `~/.agentwfy.json`)
- Free CDP port (parallel runs don't conflict)

`cdp stop` cleans up all temp files (agent data, global config, Chromium userData).

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
./scripts/cdp stop                                 # Stop app + clean up test data
./scripts/cdp wait                                 # Wait until app is ready
./scripts/cdp test                                 # Full connection test
```

Set `CDP_PORT` env var if using a different port (default: 9223).

### Real input (UI interaction)

These commands dispatch events through Chromium's input pipeline — real clicks and keystrokes, not JS injection. They work without the app being focused and traverse Shadow DOM automatically.

```bash
./scripts/cdp click <selector>              # Click element (deep-queries shadow DOM)
./scripts/cdp click-target <id> <selector>  # Click element in specific target
./scripts/cdp click-at <x> <y>              # Click at raw coordinates
./scripts/cdp type <text>                   # Type text via key events
./scripts/cdp type-target <id> <text>       # Type text in specific target
./scripts/cdp press <key+combo>             # Press key combo (e.g., Meta+k, Enter)
./scripts/cdp press-target <id> <key+combo> # Press key combo in specific target
./scripts/cdp fill <selector> <text>        # Click, clear, type into element
./scripts/cdp fill-target <id> <sel> <text> # Fill element in specific target
./scripts/cdp wait-for <selector> [timeout] # Wait for element to be visible (default: 10s)
./scripts/cdp wait-for-target <id> <sel> [t]# Wait for element in specific target
./scripts/cdp assert-visible <selector>     # Assert element is visible
./scripts/cdp assert-text <selector> <text> # Assert element contains text
./scripts/cdp assert-gone <selector>        # Assert element is not in DOM
```

Example — open command palette, navigate to sessions, load the first one:

```bash
./scripts/cdp press Meta+k
# Find the command palette target ID
./scripts/cdp targets
./scripts/cdp type-target <id> ses
./scripts/cdp click-target <id> ".item:nth-child(2)"
./scripts/cdp click-target <id> ".item:first-child"
./scripts/cdp screenshot /tmp/session.png
```

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

Agent view tabs and URL tabs are always present while open. The command palette only appears as a target while it's open — open it first with `cdp press Meta+k`.

## IPC API

**Important:** IPC calls bypass the UI — they invoke main process handlers directly without clicking buttons, typing in inputs, or triggering event listeners. A test that uses `window.ipc.tabs.openTab(...)` won't catch a broken tab bar click handler. Prefer real input commands (`click`, `type`, `press`) for testing user-facing flows. Use IPC for setup/teardown, reading state, or operations unrelated to what you're currently testing (e.g., using IPC to set up data before testing a UI flow that reads it).

The main page exposes `window.ipc`. Call via `cdp eval` or `cdp ipc`:

```javascript
// SQL
window.ipc.sql.run({ sql: 'SELECT * FROM views', params: [] })

// Files
window.ipc.files.read(path)
window.ipc.files.write(path, content)
window.ipc.files.writeBinary(path, base64)
window.ipc.files.readBinary(path)
window.ipc.files.edit(path, oldText, newText)
window.ipc.files.ls(path?, limit?)
window.ipc.files.mkdir(path, recursive?)
window.ipc.files.remove(path, recursive?)
window.ipc.files.find(pattern, path?, limit?)
window.ipc.files.grep(pattern, path?, options?)

// Tabs
window.ipc.tabs.getTabState()
window.ipc.tabs.getTabs()
window.ipc.tabs.openTab({ viewId?, viewName?, filePath?, url?, title?, hidden? })
window.ipc.tabs.closeTab({ tabId: '...' })
window.ipc.tabs.selectTab({ tabId: '...' })
window.ipc.tabs.reloadTab({ tabId: '...' })
window.ipc.tabs.captureTab({ tabId: '...' })      // → base64 PNG
window.ipc.tabs.getConsoleLogs({ tabId: '...', since?, limit? })
window.ipc.tabs.execJs({ tabId: '...', code: '...', timeoutMs? })
window.ipc.tabs.reorderTabs(tabIds)
window.ipc.tabs.togglePin({ tabId: '...' })
window.ipc.tabs.revealTab({ tabId: '...' })
window.ipc.tabs.toggleDevTools({ tabId: '...' })
window.ipc.tabs.showContextMenu({ tabId: '...' })

// Command palette
window.ipc.commandPalette.show(options?)           // options: { screen?, params? }
window.ipc.commandPalette.showFiltered(query)

// Agent sessions
window.ipc.agent.createSession({ label?, prompt?, providerId? })
window.ipc.agent.sendMessage(text, options?)       // options: { streamingBehavior? }
window.ipc.agent.abort()
window.ipc.agent.getSnapshot()
window.ipc.agent.onSnapshot(callback)
window.ipc.agent.onStreaming(callback)
window.ipc.agent.closeSession()
window.ipc.agent.loadSession(file)
window.ipc.agent.switchTo(sessionId)
window.ipc.agent.getSessionList()
window.ipc.agent.disposeSession(file)
window.ipc.agent.setNotifyOnFinish(value)
window.ipc.agent.reconnect()
window.ipc.agent.retryNow()

// Agent sidebar
window.ipc.agentSidebar.getInstalled()
window.ipc.agentSidebar.switch(agentRoot)
window.ipc.agentSidebar.add()
window.ipc.agentSidebar.addFromFile()
window.ipc.agentSidebar.remove(agentRoot)
window.ipc.agentSidebar.reorder(agentPaths)
window.ipc.agentSidebar.showContextMenu(agentRoot)
window.ipc.agentSidebar.onSwitched(callback)

// Tasks
window.ipc.tasks.start(taskId, input?, origin?)
window.ipc.tasks.stop(runId)
window.ipc.tasks.listRunning()
window.ipc.tasks.listLogHistory()
window.ipc.tasks.listLogs(limit?)
window.ipc.tasks.readLog(logFileName)
window.ipc.tasks.writeLog(logFileName, content)

// Plugins
window.ipc.plugins.call(method, params)
window.ipc.plugins.methods()
window.ipc.plugins.uninstall(pluginName)

// Providers
window.ipc.providers.list()
window.ipc.providers.getStatusLine(providerId)

// Sessions (raw file access)
window.ipc.sessions.list(limit?)
window.ipc.sessions.read(sessionFileName)
window.ipc.sessions.write(sessionFileName, content)

// Store (persistent key-value)
window.ipc.store.get(key)
window.ipc.store.set(key, value)
window.ipc.store.remove(key)

// Dialog
window.ipc.dialog.open(options)
window.ipc.dialog.openExternal(url)

// Event bus (inter-agent messaging)
window.ipc.bus.publish(topic, data)
window.ipc.bus.waitFor(topic, timeoutMs?)

// Database change notifications
window.ipc.db.onDbChanged(callback)

// App control
window.ipc.restart()
window.ipc.stop()
window.ipc.reloadRenderer()
window.ipc.getAgentRoot()
window.ipc.getHttpApiPort()
window.ipc.getBackupStatus()
window.ipc.getDefaultView()
```

## Parallel Runs

Multiple `cdp start` calls run safely in parallel — each gets a unique port, app ID, and temp directory. No coordination needed:

```bash
./scripts/cdp start    # → port: 57407
./scripts/cdp start    # → port: 58192
./scripts/cdp start    # → port: 59001
```

Each instance is fully isolated. `CDP_PORT=<port> ./scripts/cdp stop` cleans up that specific instance.

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
