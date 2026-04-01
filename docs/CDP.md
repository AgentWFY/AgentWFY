# CDP Tool Reference

`scripts/cdp` — Chrome DevTools Protocol client for app automation.

## Commands

```
./scripts/cdp start [--visible]      Start isolated test instance (headless by default)
./scripts/cdp stop                   Stop app and clean up test data
./scripts/cdp restart                Restart app and wait until ready
./scripts/cdp run <script-or-file>   Execute a JS test script with the full API
```

`CDP_PORT=<port>` env var selects which instance to talk to.

### start

Spawns a fully isolated instance: temp agent dir, unique app ID, temp global config, auto-picked free port. Prints `port: <N>` on success.

```bash
./scripts/cdp start                    # headless
./scripts/cdp start --visible          # show window
```

### stop

Stops the app and deletes all temp data (agent dir, Chromium userData, global config).

### restart

Sends restart to the running app, waits until the new instance is ready. Use after `./scripts/build`.

### run

Accepts an inline JS string or a file path. The script runs in Node.js with all API functions as top-level variables.

```bash
./scripts/cdp run 'await screenshot("/tmp/app.png")'
./scripts/cdp run tests/my-test.js
```

## Output Format

Scripts produce structured JSONL (one JSON object per line):

```jsonl
{"type":"action","action":"click","selector":".btn","x":120,"y":45}
{"type":"assert","assertion":"text","selector":".msg","expected":"hello","actual":"hello world"}
{"type":"log","label":"tabs","data":[{"id":"1","title":"Home"}]}
{"type":"result","data":{"passed":true}}
{"type":"error","message":"Element not found","stack":"..."}
```

| Type | When |
|------|------|
| `action` | Automatically on input/screenshot calls |
| `assert` | Automatically when an assertion passes |
| `log` | When script calls `log(label, data)` |
| `result` | Script return value (if any) |
| `error` | Unhandled error (exit code 1) |

## API Reference

All functions are async unless noted. All selectors traverse Shadow DOM automatically.

### Targets

```js
await targets()       // → [{id, fullId, type, title, url}, ...]
await mainTarget()    // → {id, fullId, type, title, url}
```

Separate CDP targets exist for: main window, each WebContentsView tab, command palette (when open), confirmation dialogs.

### Eval

```js
await eval(js)                   // Run JS in main renderer, return value
await evalTarget(targetId, js)   // Run JS in specific target
```

Runs inside the renderer process. Returns deserialized value.

### Real Input

Dispatches through Chromium's input pipeline — real clicks and keystrokes, not JS injection.

```js
await click(selector)                    // Deep-query + click center
await clickTarget(targetId, selector)
await clickAt(x, y)                      // Raw coordinates

await type(text)                         // Character by character
await typeTarget(targetId, text)

await press(combo)                       // "Meta+k", "Enter", "Shift+Tab"
await pressTarget(targetId, combo)

await fill(selector, text)               // Click + select all + delete + type
await fillTarget(targetId, selector, text)
```

### Waiting & Assertions

```js
await waitFor(selector, timeoutSecs?)              // Default 10s
await waitForTarget(targetId, selector, timeoutSecs?)

await assertVisible(selector)            // Throws if zero-size or missing
await assertText(selector, expected)     // Throws if text doesn't contain expected
await assertGone(selector)               // Throws if element exists in DOM
```

### Screenshots

```js
await screenshot(path?)                  // Default: /tmp/agentwfy-screenshot.png
await screenshotTarget(targetId, path?)
```

Returns the output path.

### DOM Queries

```js
await getRect(selector)    // → {x, y, width, height}
await getText(selector)    // → string (trimmed textContent)
await getHTML(selector)    // → string (innerHTML)
```

### Utility

```js
await sleep(ms)
log(label, data)           // Emit structured log line (sync)
await logs(n?)             // Last n lines of main process log (default 50)
```

## Parallel Runs

Multiple `start` calls are safe — each gets its own port, app ID, and temp dir:

```bash
./scripts/cdp start    # → port: 57407
./scripts/cdp start    # → port: 58192
CDP_PORT=57407 ./scripts/cdp run '...'
CDP_PORT=58192 ./scripts/cdp run '...'
```

## macOS Screen Control

For native UI not reachable via CDP (file picker dialogs, menu bar):

```bash
./scripts/macos-control screenshot-app Electron /tmp/app.png
./scripts/macos-control click 500 300
./scripts/macos-control type "hello"
./scripts/macos-control key k command
./scripts/macos-control list-windows Electron
./scripts/macos-control menu Electron File "Open Agent…"
```
