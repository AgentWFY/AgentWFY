Direct Chrome DevTools Protocol access to a tab. Lets you do anything CDP supports: network intercept, screencast, PDF export, perf traces, heap snapshots, emulation, accessibility tree, etc. Refer to the upstream CDP reference for command/event names and shapes.

- `tabDebuggerSend({ id, method, params?, sessionId? })` → CDP result. Auto-attaches on first call. `sessionId` targets a child target (OOPIF, worker); omit for the page session.
- `tabDebuggerSubscribe({ id, events })` → an async-iterable subscription handle. `events` is an array of CDP event names (e.g. `['Network.responseReceived', 'Page.loadEventFired']`); use `['*']` for all events. Iterate with `for await (const evt of sub) { ... }`. Each `evt` is `{ method, params, sessionId? }`; if events were dropped due to a slow consumer, the next yielded event also carries `evt.dropped` (count since last delivery). Subscribe before sending the command that produces the events.
- `sub.close()` — stop receiving and detach the subscription. Iteration also cleans up automatically if you `break` out of the loop or the subscription's tab is closed.
- `tabDebuggerDetach(id)` — detach the debugger from a tab and close all its subscriptions. Accepts a string or `{ id }`.

Constraints:
- One CDP client per tab. Attaching fails if the user has DevTools open on that tab; opening DevTools while attached is blocked. Detach if the user needs DevTools.
- Subscribe only to events you actually consume. The per-subscription buffer caps at 1000 events — high-volume events (`Network.*`, `Runtime.consoleAPICalled`, `Page.screencastFrame`) drop oldest if you can't keep up. The drop count surfaces on `evt.dropped` so you can detect loss.
- Only one concurrent iteration per subscription handle. Don't share a handle across two `for await` loops.
- For OOPIFs / workers, enable `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })` and route follow-up commands using the `sessionId` from `Target.attachedToTarget`.
- Large results (heap snapshots, full DOM) come back as one JSON value — prefer the chunked event variants where CDP offers them.
- Auto-detaches on tab close or external detach (e.g. user opens DevTools). Otherwise stays attached until you call `tabDebuggerDetach`.
