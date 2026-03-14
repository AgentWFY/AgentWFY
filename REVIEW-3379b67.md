# Code Review: Commit 3379b67 — Multi-window agent architecture

## Bugs

### 1. Menu not rebuilt when new agent windows are opened
**`src/main.ts`** — `buildAndSetMenu()` is only called inside `createInitialWindow()`. When subsequent agent windows are opened via `handleOpenAgent()`, `handleInstallAgent()`, or `handleSwitchAgent()`, the menu is never rebuilt. The old code called `buildAndSetMenu()` inside `onAgentRootChanged`, so the recent agents submenu always stayed current. Now the "Switch Agent" submenu becomes stale after the first window.

**Fix:** Call `buildAndSetMenu()` after each `windowManager.openAgentInWindow()` call.

### 2. Dialogs lost their parent window — no longer modal
**`src/main.ts:168-180`** — `handleOpenAgent()`, `handleInstallAgent()`, and `handleSwitchAgent()` now pass `null` to `showOpenAgentDialog(null)` and `showInstallAgentDialog(null)` instead of the previously used `mainWindow`. On macOS this means the file picker dialog will be non-modal and can get hidden behind other windows.

**Fix:** Pass `BrowserWindow.getFocusedWindow()` instead of `null`.

### 3. `agentHashes` map never cleaned up on window close
**`src/window-manager.ts:59`** — `destroyWindow()` removes the window from `this.windows` and cleans up `senderMap`, but never removes the entry from `this.agentHashes`. Over time (opening/closing agents), this map grows unbounded. More importantly, if an agent directory is moved/renamed, stale hash mappings persist and could resolve to wrong paths.

**Fix:** In `destroyWindow()`, remove the hash entry for the destroyed context's `agentRoot` from `this.agentHashes`.

### 4. `dbChangeDebounceTimer` not cleared on window destroy
**`src/window-manager.ts:170-185`** — `destroyWindow()` clears `triggerReloadDebounceTimer` (via `stopHttpServerForContext`) but does **not** clear `dbChangeDebounceTimer`. The 5-second timer can fire after the window is destroyed. The `win.isDestroyed()` guard prevents a crash, but it's a leaked timer.

**Fix:** Add `if (ctx.dbChangeDebounceTimer) { clearTimeout(ctx.dbChangeDebounceTimer); ctx.dbChangeDebounceTimer = null; }` to `destroyWindow()`.

### 5. Fallback webview registration registers with ALL windows
**`src/main.ts:305-310`** — The `web-contents-created` fallback loop registers a webview with every `TabViewManager` when the owning window can't be determined. This means a webview from Window A could be tracked by Window B's `TabViewManager`, causing cross-window tab pollution — wrong window receives console logs, screenshot captures, or JS execution for that tab.

**Fix:** Log a warning instead of silently registering with all contexts, or find a more reliable ownership mechanism.

### 6. Global bus state shared across windows without isolation
**`src/ipc/bus.ts:10-12`** — `pendingWaiters`, `pendingSpawnRequests`, and `activeSubscriptions` are module-level globals shared across all windows. While UUID-based keying prevents direct collisions, the `Channels.bus.waitForResolved` and `Channels.bus.subscribeEvent` listeners use `ipcMain.on` (not `ipcMain.handle`) and ignore the `_event` sender — a malicious or buggy view in Window A could resolve a waiter that belongs to Window B by sending a crafted `waiterId`.

**Fix:** Validate that the sender of resolved/result messages belongs to the same window context as the original request.

## Design Issues

### 7. Circular dependency between `window-manager.ts` and `command-palette/manager.ts`
`window-manager.ts` imports `CommandPaletteManager` from `command-palette/manager.ts`, and `command-palette/manager.ts` imports `windowManager` from `window-manager.ts`. This works today only because `windowManager` is accessed inside method bodies (lazy), not at module evaluation. It's fragile — any future change that accesses `windowManager` at the top level will cause an `undefined` import.

**Fix:** Invert the dependency — pass `openAgentInWindow` as a callback via `CommandPaletteManagerDeps` instead of importing `windowManager` directly.

### 8. `getContextForSender` throws on unknown sender — unhandled in most IPC handlers
**`src/window-manager.ts:206`** — `getContextForSender` throws `new Error(...)` when no window context is found. Only 3 handlers (`app:getAgentRoot`, `app:getHttpApiPort`, `app:getBackupStatus`) wrap calls in try/catch. All other IPC handlers (files, SQL, sessions, auth, tabs, bus, task-runner, command-palette, tab-views) will propagate the throw as a rejected IPC promise. During window creation/destruction races or from stale webContents, this can surface as unhandled errors in the renderer.

**Fix:** Either wrap all IPC routing in try/catch at the WindowManager level, or make `getContextForSender` return `null` and handle gracefully in each handler.

### 9. `openAgentInWindow` silently returns existing context for destroyed windows
**`src/window-manager.ts:358-364`** — `findWindowForAgent` returns a context if `ctx.agentRoot === agentRoot`, then `openAgentInWindow` calls `existing.window.focus()` only when `!existing.window.isDestroyed()`. If the window IS destroyed, it returns the stale context without creating a new window. The caller gets back a broken context with a destroyed `BrowserWindow`.

**Fix:** If `existing.window.isDestroyed()`, call `destroyWindow(existing.window.id)` first, then fall through to create a new window.

### 10. Hash-based protocol routing is fragile with 10-char truncation
**`src/window-manager.ts:56`** — `shortHash` uses 10 hex characters (40 bits of entropy). While collision is unlikely for typical usage, there's no collision detection. If two agent roots happen to produce the same 10-char prefix, `agentHashes.set(hash, agentRoot)` silently overwrites the first mapping, causing the first agent's views to 404.

**Fix:** Add a collision check in `getHashForAgentRoot` — if the hash already exists for a different `agentRoot`, extend or salt the hash.
