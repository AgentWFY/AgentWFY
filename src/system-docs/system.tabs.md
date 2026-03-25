The app uses a tab-based UI with three tab types:
- **view** (type="view"): DB-backed HTML stored in `views` table. Rendered as isolated webview runtimes.
- **file** (type="file"): HTML loaded from a file in the working directory. Opened via `openTab({ filePath })`.
- **url** (type="url"): External web page loaded by URL. Opened via `openTab({ url })`. Does NOT get the runtime injected.

- `getTabs()` → `{ tabs: [{ id, title, type, target, viewUpdatedAt, viewChanged, pinned, hidden, selected }] }`
  - `type`: "view", "file", or "url". `target`: view ID, file path, or URL respectively.
  - `viewChanged` means DB content was updated but tab has not been reloaded yet.
  - `hidden`: true if the tab is a hidden background tab (not shown in the tab bar).
- `openTab({ viewId, title?, hidden?, params? })` or `openTab({ viewName, title?, hidden?, params? })` or `openTab({ filePath, title?, hidden?, params? })` or `openTab({ url, title?, hidden? })` → `{ tabId }` — exactly one source required. `viewName` resolves a view by its name (e.g. `openTab({ viewName: 'Home' })`) and auto-populates the title.
  - `params`: optional `Record<string, string>` of custom query parameters appended to the view URL. Views read them via `new URLSearchParams(window.location.search)`. Not supported for URL tabs.
  - `hidden: true` opens the tab in the background without disrupting the user's current view. Hidden tabs are not shown in the tab bar but still load their content, so you can use `captureTab`, `execTabJs`, and `getTabConsoleLogs` on them. The user can expand hidden tabs in the tab bar to inspect them. Use hidden tabs when you need to do background work (e.g. rendering a view, running JS in a page context) without interrupting the user.
- `closeTab({ tabId })`, `selectTab({ tabId })`, `reloadTab({ tabId })`
- `captureTab({ tabId })` → screenshot is auto-attached as an image to the tool result
- `getTabConsoleLogs({ tabId, since?, limit? })` → `[{ level, message, timestamp }]`
- `execTabJs({ tabId, code, timeoutMs? })` → execute JS in a tab's page context (has DOM access)

Always `reloadTab` after updating view content via SQL.

Clickable links in chat messages: `[text](agentview://view/<viewId>)`, `[text](agentview://view/<viewName>)`, or `[text](agentview://file/<filePath>)`. Non-numeric paths resolve by view name. Optional `?title=...` query param sets the tab title.
