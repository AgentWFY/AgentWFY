The app uses a tab-based UI with three tab types:
- **view** (type="view"): DB-backed HTML stored in `views` table, keyed by `name`. Rendered as isolated webview runtimes.
- **file** (type="file"): HTML loaded from a file in the working directory. Opened via `openTab({ filePath })`.
- **url** (type="url"): External web page loaded by URL. Opened via `openTab({ url })`. Does NOT get the runtime injected.

- `getTabs()` → `[{ id, title, type, target, viewUpdatedAt, viewChanged, pinned, hidden, selected, params }]`
  - `type`: "view", "file", or "url". `target`: view name, file path, or URL respectively.
  - `viewChanged` means DB content was updated but tab has not been reloaded yet.
  - `hidden`: true if the tab is a hidden background tab (not shown in the tab bar).
  - `params`: the query parameters passed when the tab was opened, or null.
- `openTab({ viewName, title?, hidden?, params? })` or `openTab({ filePath, title?, hidden?, params? })` or `openTab({ url, title?, hidden? })` → `{ tabId }` — exactly one source required. `viewName` resolves a view by its name (primary key) and auto-populates the title.
  - `params`: optional `Record<string, string>` of custom query parameters appended to the view URL. Views read them via `new URLSearchParams(window.location.search)`. Not supported for URL tabs.
  - `hidden: true` opens the tab in the background without disrupting the user's current view. Hidden tabs are not shown in the tab bar but still load their content, so you can use `captureTab`, `execTabJs`, and `getTabConsoleLogs` on them. The user can expand hidden tabs in the tab bar to inspect them. Use hidden tabs when you need to do background work (e.g. rendering a view, running JS in a page context) without interrupting the user.
- `closeTab({ tabId })`, `selectTab({ tabId })`, `reloadTab({ tabId })`
- `captureTab({ tabId })` → screenshot is auto-attached as an image to the tool result. The raw image data is NOT available to code; returns `{ attached: true, mimeType }`.
- `getTabConsoleLogs({ tabId, since?, limit? })` → `[{ level, message, timestamp }]`
- `execTabJs({ tabId, code, timeoutMs? })` → execute JS in a tab's page context (has DOM access)
- `inspectElement({ tabId, selector })` → `{ found, tagName, textContent, attributes, classes, box: { x, y, width, height, top, right, bottom, left }, styles: { display, visibility, opacity, position, overflow, zIndex, boxSizing, color, backgroundColor, fontSize, fontWeight, lineHeight, textAlign, border, borderCollapse, padding, margin, width, height, minWidth, maxWidth, minHeight, maxHeight, cursor, pointerEvents, userSelect, whiteSpace, textOverflow, flexGrow, flexShrink, gridTemplateColumns }, isVisible, isInViewport, childCount, parentTag }` — returns computed styles and box model for the first element matching the CSS selector. Use to verify CSS changes actually took effect.
- `sendInput({ tabId, type, ... })` — send real input events through the browser's input pipeline (hit-testing, hover states, cursor changes). Unlike `execTabJs` with `dispatchEvent()`, these go through Chromium's compositor and hit-test against rendered layout.
  - Mouse: `sendInput({ tabId, type: 'mouseDown'|'mouseUp'|'mouseMove', x, y, button?, clickCount?, modifiers? })`
  - Click (convenience): `sendInput({ tabId, type: 'click', x, y, button?, clickCount?, modifiers? })` — sends mouseDown + mouseUp
  - Scroll: `sendInput({ tabId, type: 'mouseWheel', x, y, deltaX?, deltaY?, modifiers? })`
  - Keyboard: `sendInput({ tabId, type: 'keyDown'|'keyUp'|'char', keyCode, modifiers? })`
  - `modifiers`: array of `'shift'`, `'control'`, `'alt'`, `'meta'`
  - `button`: `'left'` (default), `'middle'`, `'right'`
  - `keyCode`: Electron accelerator key code (e.g. `'a'`, `'Enter'`, `'Tab'`, `'Backspace'`, `'ArrowDown'`)
  - Use `sendInput` over synthetic DOM events when testing real user interactions (clicking, dragging, resizing, typing). Synthetic `dispatchEvent()` skips hit-testing — it fires on whichever element you target in JS regardless of whether it's actually clickable at those coordinates.

Always `reloadTab` after updating view content via SQL.

Clickable links in chat messages: `[text](agentview://view/<viewName>)` or `[text](agentview://file/<filePath>)`. Optional `?title=...` query param sets the tab title.
