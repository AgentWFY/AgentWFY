# system.views

Views are HTML rendered as isolated webview runtimes. There are two kinds:

- **DB views** — stored in `views` table (target="agent"), keyed by `name`. Opened for the user via `openClientPage({ source: { type: 'view', name } })`.
- **File views** — HTML files in the working directory. Opened for the user via `openClientPage({ source: { type: 'file', path } })`.

Both get CSS design tokens, base reset, and host APIs via `window.agentwfy.<method>(...)`. URL pages (`openClientPage({ source: { type: 'url', url } })`) do NOT get the runtime.

**Opening by name:** `openClientPage({ source: { type: 'view', name: 'my-view' } })` resolves the view by its `name` column (primary key) and auto-populates the page title. Always use a `view` source to open views.

**View params:** Pass custom parameters in the source via `openClientPage({ source: { type: 'view', name, params: { key: 'value' } } })`. Views read params with `new URLSearchParams(window.location.search).get('key')`. Use this for navigation between views (e.g. a list view opening a detail view with an entity ID).

**Default behavior:** prefer file views in `.tmp/` directory for displaying data. Only create DB views when the user explicitly asks for a persistent view.

## View Naming Convention

View names must contain only **lowercase letters, digits, dots, hyphens, and underscores** (e.g. `my-dashboard`, `sales.overview`). This is enforced by the database — inserts/updates with invalid names will be rejected.

DB views follow a naming convention with prefixes:

- **`system.*`** — Built-in views shipped with the app (e.g. `system.plugins`, `system.docs`). Read-only — cannot be modified via SQL.
- **`plugin.*`** — Views installed from plugin packages (e.g. `plugin.ffmpeg.config`). Read-only — managed by the plugin installer.
- **No prefix** — User-created views. Fully editable.

The `title` field provides a human-readable display name for a view. When `title` is set, it is used in the command palette and tab bar instead of the raw `name`.

## View Runtime

Each view (DB or file) gets a bootstrap injected by the app:
- CSS design tokens with automatic light/dark switching via `color-scheme: light dark`
- Base reset (box-sizing, font-family, margin:0, color: var(--color-text3), background: var(--color-bg1))
- Initial guard that hides content until the view is ready (revealed on first animation frame or 5s timeout)
- Host APIs via `window.agentwfy.<method>(...)` — same APIs as in execJs, plus `agentwfy.fetch` for HTTP requests that need restricted headers and `agentwfy.setWsHeaders` for WebSocket handshake headers (see below)

## CSS Variables

Injected automatically — no need to define them.

**Typography & Layout:**
--font-family, --font-mono, --radius-sm (4px), --radius-md (6px), --transition-fast (120ms ease), --transition-normal (200ms ease-out)

**Colors (auto light/dark):**
--color-bg1, --color-bg2, --color-bg3, --color-surface
--color-border, --color-divider
--color-text1 (muted), --color-text2 (secondary), --color-text3 (primary), --color-text4 (strong)
--color-placeholder
--color-accent, --color-accent-hover, --color-focus-border
--color-red-bg, --color-red-fg, --color-green-bg, --color-green-fg, --color-yellow-bg, --color-yellow-fg
--color-selection-bg, --color-selection-fg, --color-item-hover
--color-input-bg, --color-input-border
--color-code-bg

Light: bg1=#ffffff, bg2=#f8f8f8, bg3=#f0f0f0, surface=#ffffff, border=#e0e0e0, text1=#6b6b6b, text2=#999999, text3=#444444, text4=#1a1a1a, accent=#1a6fb5
Dark: bg1=#1e1e1e, bg2=#252526, bg3=#1a1a1a, surface=#2d2d2d, border=#3d3d3d, text1=#b0b0b0, text2=#808080, text3=#cccccc, text4=#e0e0e0, accent=#2b7ab5

## Fetch

Views have access to `window.agentwfy.fetch()` which makes HTTP requests from the main process (Node.js). Unlike the browser's `fetch`, this can set any headers including `User-Agent`.

```js
const result = await window.agentwfy.fetch({
  url: 'https://api.example.com/data',
  method: 'POST',                          // optional, default 'GET'
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'my-app' },  // optional
  body: JSON.stringify({ key: 'value' }),   // optional
})
// result: { status: 200, body: '...' }
```

## WebSocket

`new WebSocket(url)` works directly in views — no task needed. The handshake's `Origin` (the view's internal host, which no service allowlists) is stripped, matching what Node sends from execJs. Servers that require an allowlisted `Origin`, rather than just rejecting unknown ones, need the explicit form below.

To send a specific `Origin` or extra handshake headers, register them first. This is the only way to put `Authorization` or a custom `Cookie` on a handshake — the browser `WebSocket` API takes no headers.

```js
await window.agentwfy.setWsHeaders({
  url: 'wss://api.example.com/stream',
  origin: 'https://app.example.com',         // optional
  headers: { Authorization: 'Bearer ...' },  // optional
})
const ws = new WebSocket('wss://api.example.com/stream')
```

The registration is consumed by the next handshake to that exact URL and expires after 30s. Handshake-critical headers (`Upgrade`, `Connection`, `Sec-WebSocket-*`) are rejected; pass subprotocols as the `WebSocket` constructor's second argument instead.

Cookies from the agent's session are sent as usual, but only `SameSite=None` ones — a view is cross-site to any real target. Supply others explicitly via `headers.Cookie`.

## Modules

Modules store reusable JS/CSS in the `modules` table, served at `/module/<name>` (relative to the view). Use them to split large views into components and share code across views.

```
modules (name PK [must end in .js or .css], content, created_at, updated_at)
```

**Naming:** module names must end with `.js` or `.css` — the extension determines the served Content-Type (there is no separate `type` column). Name format: `[a-z0-9._-]+` (e.g. `note-render.js`, `ui.data-table.css`). `system.*` and `plugin.*` are read-only. Modules named `<view_name>.*` are auto-deleted when that view is deleted (e.g. `dashboard.filters.js` is deleted with view `dashboard`). Shared modules (e.g. `ui.data-table.js`) are not tied to any view.

**Loading in views:** `<script src="/module/note-render.js">` for JS, `<link rel="stylesheet" href="/module/note-render.css">` for CSS. Use regular `<script>` (not `type="module"`) so variables stay accessible to `runPageJs`.

**Writing:** `write({ path: '@modules/foo.js', content })` creates/updates a JS module. Same for `.css`. Writing a name without a `.js`/`.css` suffix is rejected.

`reloadPage` after updating any module or view content.

**Recommended pattern — Web Components:** store each UI piece as a JS module defining a custom element. The view becomes a thin shell of `<script src>` tags and custom element tags. Each component is independently editable without touching the view or other components.

For large views, prefer splitting into modules.

## Browser API Limitations

Views run inside Electron WebContentsView, which does **not** support modal browser dialogs:

- **`prompt()`**, **`confirm()`**, **`alert()`** — silently fail (return `undefined` / `null`). Use inline HTML forms and custom UI instead.

These are Electron platform constraints, not bugs. Design views with inline interactions rather than relying on browser dialogs.

## Debugging Views

**Always use headless pages for development/testing.** When opening pages to test, debug, capture screenshots, or run JS, use `openPage`:

```js
await openPage({ source: { type: 'view', name } })
await openPage({ source: { type: 'file', path } })
```

Client pages take over the user's selected page surface. Headless pages load without selecting a client tab and support `capturePage`, `runPageJs`, and `getPageConsoleLogs`. Only use `openClientPage` when presenting a finished result to the user. Headless pages close after 30 minutes idle by default; pass `closeAfterIdleMs: "never"` only when the page must stay open until `closePage`.

Always close headless pages and remove `.tmp/` files when done.

**Tools:** `capturePage({ pageId })` for screenshots, `getPageConsoleLogs({ pageId })` for console output, `runPageJs({ pageId, code })` to run JS in the view's page context (full DOM access), `inspectPageElement({ pageId, selector })` to see computed styles and box model.
