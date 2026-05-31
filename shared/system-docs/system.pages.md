# system.pages

Pages are browser/view contexts the agent can inspect or control. Tabs are only
one desktop presentation for user-facing pages.

- `getPages({ display? })` -> page metadata. `display` can be
  `"foreground"`, `"background"`, `"headless"`, `"user-facing"`, or `"all"`.
  Default is `"all"`.
- `getCurrentPage()` -> the current foreground page for the active surface, or
  `null`.
- `openPage({ source, display, title?, viewport?, width?, height?, closeAfterIdleMs? })`
  -> `{ id, pageId, page, info }`.
  `display` is required: `"foreground"`, `"background"`, or `"headless"`.
- `showPage(id)` -> make a user-facing page foreground.
- `closePage(id)` -> close a page.
- `reloadPage(id)` -> reload and return updated page metadata.
- `waitForPage({ pageId, lifecycle?, timeoutMs? })` -> wait for `"ready"`.
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

Use headless pages for development/testing and user-facing pages only when the
user should see the result. Headless pages close after 30 minutes idle by
default; pass `closeAfterIdleMs: "never"` only when the page must stay open
until `closePage`.
