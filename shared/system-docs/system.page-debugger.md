# system.page-debugger

Chrome DevTools Protocol helpers for pages that report `capabilities.cdp`.

- `sendPageCdp({ pageId, method, params?, sessionId? })` -> CDP result.
- `subscribePageCdp({ pageId, events })` -> async-iterable subscription
  handle. `events` is an array of CDP event names such as
  `['Network.responseReceived', 'Page.loadEventFired']`; use `['*']` for all
  events. Iterate with `for await (const evt of sub) { ... }`.
- `detachPageCdp(id)` -> detach from a page and close all its subscriptions.

Subscribe before sending the command that produces the events. Subscriptions
close automatically on page close or detach.
