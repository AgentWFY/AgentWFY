Tabs are rendered browser pages the agent can use for visual work: opening views, loading files or URLs, taking screenshots, running page JavaScript, inspecting layout, and sending real input. The same functions work for visible user tabs and headless tabs; each tab entry says which kind it is.

- `getTabs()` -> `[{ id, tabId, title, type, target, headless, viewport, viewUpdatedAt, viewChanged, pinned, selected, params, openedAt?, lastUsedAt?, closeAfterIdleMs?, expiresAt? }]`
  - `type`: `"view"`, `"file"`, or `"url"`.
  - `target`: view name, file path, or URL.
  - `headless`: true for an agent-owned page not shown in the tab bar.
  - `viewport`: `{ width, height }` for headless tabs, otherwise `null`.
- `getCurrentTab()` -> the user's currently selected visible tab, or `null`.
- `openTab({ viewName?, filePath?, url?, headless?, viewport?, closeAfterIdleMs?, title?, params? })` -> `{ id, tabId, info }`. Exactly one source is required. `viewName` resolves a view by name and auto-populates the title. `info` briefly describes what opened and, for headless tabs, how cleanup works.
  - Agent `execJs` default: `headless: true`.
  - View runtime `window.agentwfy.openTab` default: `headless: false`.
  - `headless: false` opens a visible tab in the user's tab bar. Use it when presenting a finished result or following an in-app navigation from a view.
  - `headless: true` opens an off-screen rendered page. Use it for screenshots, layout checks, scraping, and interaction tests without disrupting the user.
  - `viewport` applies only to headless tabs: `"mobile"` -> 375x667, `"tablet"` -> 768x1024, `"desktop"` -> 1280x720, or pass `{ width, height }`. Omitted means desktop.
  - Headless tabs close after 30 minutes idle by default. Activity is using the tab API for that tab: `captureTab`, `execTabJs`, `sendInput`, `reloadTab`, `getTabConsoleLogs`, `inspectElement`, or tab debugger calls.
  - `closeAfterIdleMs` applies only to headless tabs. Pass a positive millisecond value to override the idle timeout, or `"never"` to keep the tab open until `closeTab`.
  - `params` is an optional `Record<string, string>` appended to view/file URLs. Views read it via `new URLSearchParams(window.location.search)`.
- `closeTab(id)`, `selectTab(id)`, `reloadTab(id)` accept a plain string, `{ id }`, or `{ tabId }`. `selectTab` only matters for visible tabs.
- `captureTab(id)` -> screenshot is auto-attached as an image to the tool result. The raw image data is not available to code; returns `{ attached: true, mimeType }`.
- `getTabConsoleLogs({ id, since?, limit? })` -> `[{ level, message, timestamp }]`.
- `execTabJs({ id, code, timeoutMs? })` -> execute JavaScript in the page context. `code` can be a bare expression or a function body with statements. Returns `null` when the result is `undefined`.
- `inspectElement({ id, selector })` -> computed styles and box model for the first element matching the CSS selector.
- `sendInput({ id, type, ... })` sends real input through the browser's input pipeline:
  - Mouse: `mouseDown`, `mouseUp`, `mouseMove`, `click`
  - Scroll: `mouseWheel`
  - Keyboard: `keyDown`, `keyUp`, `char`
  - Common fields: `x`, `y`, `button`, `clickCount`, `deltaX`, `deltaY`, `keyCode`, `modifiers`

Use headless tabs for development/testing and visible tabs only when the user should see the result. Do not manipulate visible tabs returned by `getTabs()` or `getCurrentTab()` unless the user asked you to work with that tab.

Users may watch a headless tab through client UI while it runs. The API does not change when watched; still narrate what you are doing, for example: "I opened a headless mobile viewport to check the layout."

For low-level CDP access (network intercept, screencast, PDF, perf), see `@docs/system.tab-debugger`.

Always `reloadTab` after updating view content or modules via SQL.

Clickable links in chat messages: `[text](/view/<viewName>)` or `[text](/file/<filePath>)`. Optional `?title=...` query param sets the tab title.
