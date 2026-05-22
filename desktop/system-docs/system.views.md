# system.views

Views are HTML rendered as isolated webview runtimes. There are two kinds:

- **DB views** — stored in `views` table (target="agent"), keyed by `name`. Opened via `openTab({ viewName })`.
- **File views** — HTML files in the working directory. Opened via `openTab({ filePath })`.

Both get CSS design tokens, base reset, and host APIs via `window.agentwfy.<method>(...)`. URL tabs (`openTab({ url })`) do NOT get the runtime.

**Opening by name:** `openTab({ viewName: 'my-view' })` resolves the view by its `name` column (primary key) and auto-populates the tab title. Always use `viewName` to open views.

**View params:** Pass custom parameters when opening a view via `openTab({ viewName, params: { key: 'value' } })`. Views read params with `new URLSearchParams(window.location.search).get('key')`. Use this for navigation between views (e.g. a list view opening a detail view with an entity ID).

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
- Host APIs via `window.agentwfy.<method>(...)` — same APIs as in execJs, plus `agentwfy.fetch` for HTTP requests that need restricted headers (see below)

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

## Modules

Modules store reusable JS/CSS in the `modules` table, served via `agentview://module/<name>`. Use them to split large views into components and share code across views.

```
modules (name PK [must end in .js or .css], content, created_at, updated_at)
```

**Naming:** module names must end with `.js` or `.css` — the extension determines the served Content-Type (there is no separate `type` column). Name format: `[a-z0-9._-]+` (e.g. `note-render.js`, `ui.data-table.css`). `system.*` and `plugin.*` are read-only. Modules named `<view_name>.*` are auto-deleted when that view is deleted (e.g. `dashboard.filters.js` is deleted with view `dashboard`). Shared modules (e.g. `ui.data-table.js`) are not tied to any view.

**Loading in views:** `<script src="agentview://module/note-render.js">` for JS, `<link rel="stylesheet" href="agentview://module/note-render.css">` for CSS. Use regular `<script>` (not `type="module"`) so variables stay accessible to execTabJs.

**Writing:** `write({ path: '@modules/foo.js', content })` creates/updates a JS module. Same for `.css`. Writing a name without a `.js`/`.css` suffix is rejected.

`reloadTab` after updating any module or view content.

**Recommended pattern — Web Components:** store each UI piece as a JS module defining a custom element. The view becomes a thin shell of `<script src>` tags and custom element tags. Each component is independently editable without touching the view or other components.

For large views, prefer splitting into modules.

## Browser API Limitations

Views run inside Electron WebContentsView, which does **not** support modal browser dialogs:

- **`prompt()`**, **`confirm()`**, **`alert()`** — silently fail (return `undefined` / `null`). Use inline HTML forms and custom UI instead.

These are Electron platform constraints, not bugs. Design views with inline interactions rather than relying on browser dialogs.

## Debugging Views

**Always use hidden tabs for development/testing.** When opening tabs to test, debug, capture screenshots, or run JS — NEVER open visible tabs. Use `hidden: true`:

```js
await openTab({ viewName: name, hidden: true })
await openTab({ filePath: path, hidden: true })
```

Visible tabs steal the user's focus and clutter their tab bar. Hidden tabs load fully in the background and support `captureTab`, `execTabJs`, and `getTabConsoleLogs`. Only open a visible tab when presenting a finished result to the user.

Always close hidden tabs and remove `.tmp/` files when done.

**Tools:** `captureTab({ tabId })` for screenshots, `getTabConsoleLogs({ tabId })` for console output, `execTabJs({ tabId, code })` to run JS in the view's page context (full DOM access), `inspectElement({ id, selector })` to see computed styles and box model.
