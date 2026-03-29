# system.views

Views are HTML rendered as isolated webview runtimes. There are two kinds:

- **DB views** — stored in `views` table (target="agent"). Opened via `openTab({ viewId })` or `openTab({ viewName })`. Always bump `updated_at` when updating content.
- **File views** — HTML files in the working directory. Opened via `openTab({ filePath })`.

Both get CSS design tokens, base reset, and host APIs via `window.agentwfy.<method>(...)`. URL tabs (`openTab({ url })`) do NOT get the runtime.

**Opening by name:** `openTab({ viewName: 'Home' })` resolves the view by its `name` column and auto-populates the tab title. Prefer `viewName` over `viewId` when the name is known — no need to query the DB for the ID first.

**View params:** Pass custom parameters when opening a view via `openTab({ viewId, params: { key: 'value' } })` or `openTab({ viewName, params: { key: 'value' } })`. Views read params with `new URLSearchParams(window.location.search).get('key')`. Use this for navigation between views (e.g. a list view opening a detail view with an entity ID).

**Default behavior:** prefer file views in `.tmp/` directory for displaying data. Only create DB views when the user explicitly asks for a persistent view.

## View Naming Convention

View names must contain only **lowercase letters, digits, dots, hyphens, and underscores** (e.g. `my_dashboard`, `sales.overview`). This is enforced by the database — inserts/updates with invalid names will be rejected.

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
- Host APIs via `window.agentwfy.<method>(...)` — same APIs as in execJs

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

## Working with Large Views

For small views (under ~40000 characters), read/write the full content normally. For large views, use targeted reads and surgical edits instead of loading everything.

**Structure views with sections** — use `<style id="...">` and `<script id="...">` tags to create named sections. Add a SECTIONS comment at the top of `<head>` listing all IDs with one-line descriptions. Split CSS by concern (layout, components, page-specific) and JS by concern (state, API, rendering, init). This lets you read just the TOC (~500 chars) to understand the view, then load only the section you need.

**Reading a section** — use `INSTR()` to find a section, `SUBSTR()` to read it:
```js
// Read the TOC
await runSql({ target: 'agent', sql: 'SELECT SUBSTR(content, 1, 500) as head FROM views WHERE id = ?', params: [viewId] })

// Read a specific section
const [{start}] = await runSql({
  target: 'agent',
  sql: `SELECT INSTR(content, '<script id="script-chart">') as start FROM views WHERE id = ?`,
  params: [viewId]
})
const [{end}] = await runSql({
  target: 'agent',
  sql: `SELECT INSTR(SUBSTR(content, ?), '</script>') + ? - 1 + 9 as end FROM views WHERE id = ?`,
  params: [start, start, viewId]
})
await runSql({ target: 'agent', sql: 'SELECT SUBSTR(content, ?, ?) as s FROM views WHERE id = ?', params: [start, end - start, viewId] })
```

**Surgical edits** — use `REPLACE()` with enough context in `oldText` to match uniquely (`REPLACE()` replaces all occurrences):
```js
await runSql({
  target: 'agent',
  sql: 'UPDATE views SET content = REPLACE(content, ?, ?), updated_at = unixepoch() WHERE id = ?',
  params: [oldText, newText, viewId]
})
```

`reloadTab` after updating view content when presenting the result to the user or when you need to interact with the tab.

## Debugging Views

**Always use hidden tabs for development/testing.** When opening tabs to test, debug, capture screenshots, or run JS — NEVER open visible tabs. Use `hidden: true`:

```js
await openTab({ viewId: id, hidden: true })
await openTab({ filePath: path, hidden: true })
```

Visible tabs steal the user's focus and clutter their tab bar. Hidden tabs load fully in the background and support `captureTab`, `execTabJs`, and `getTabConsoleLogs`. Only open a visible tab when presenting a finished result to the user.

Always close hidden tabs and remove `.tmp/` files when done.

**Tools:** `captureTab({ tabId })` for screenshots, `getTabConsoleLogs({ tabId })` for console output, `execTabJs({ tabId, code })` to run JS in the view's page context (full DOM access).
