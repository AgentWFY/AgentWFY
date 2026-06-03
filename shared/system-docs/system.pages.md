# system.pages

Pages are browser/view contexts the agent can inspect or control.

- `getPages({ headless? })` -> page metadata. Pass `headless: true` for
  headless pages, `headless: false` for client pages, or omit it for all pages.
- `getCurrentClientPage()` -> the client page the user currently has selected
  for this agent, or `null`.
- `openPage({ source, title?, width?, height?, closeAfterIdleMs? })`
  -> `{ id, pageId, page, info }`.
  Always opens a headless page.
- `openClientPage({ source, title? })` -> `{ id, pageId, page, info }`.
  Opens and selects a client page. Fails if no client is connected.
- `closePage(id)` -> close a page.
- `reloadPage(id)` -> reload and return updated page metadata.
- `capturePage(id)` -> screenshot is auto-attached as an image to the tool
  result. The raw image data is not available to code; returns
  `{ attached: true, mimeType }`.
- `getPageConsoleLogs({ pageId, since?, limit? })` ->
  `[{ level, message, timestamp }]`.
- `runPageJs({ pageId, code, timeoutMs? })` -> execute JavaScript in the page
  context. `code` can be a bare expression or a function body with statements.
- `inspectPageElement({ pageId, selector })` -> computed styles and box model
  for the first element matching the CSS selector.
- `sendPageInput({ pageId, type, ... })` sends browser input events.

Sources:

```js
{ type: 'view', name: 'my-view', params: { id: '123' } }
{ type: 'file', path: '.tmp/report.html', params: { id: '123' } }
{ type: 'url', url: 'https://example.com' }
```

Returned page metadata is intentionally small:

```js
{ pageId, title, source, headless }
```

Use headless pages for development/testing and client pages only when the user
should see the result. Headless pages close after 30 minutes idle by
default; pass `closeAfterIdleMs: "never"` only when the page must stay open
until `closePage`.
