# Recording Demo Videos

Demo videos are recorded against a running `./scripts/preview` (Docker + sway + wayvnc + Electron). Each demo is a short Node script that drives the app through `./scripts/preview` and its `--eval` / `--eval --tab` / `--exec` hooks; the compositor output is captured with `wf-recorder` inside the container.

Completed demos live in `demos/<name>/`, one subfolder per demo. Each holds the driver script and the rendered MP4.

## Directory layout

```
scripts/
└── record-demo                # orchestrates a single recording

demos/
├── chat-and-trace/
│   ├── driver.js              # the script that produced the video
│   └── demo.mp4               # rendered video
└── full-tour/
    ├── driver.js
    └── demo.mp4
```

A new demo is always two files in a new subfolder: `driver.js` (the script) and `demo.mp4` (the artifact produced by running it). The orchestration lives in `scripts/` alongside the other runnable entrypoints (`build`, `start`, `preview`, …).

## Prerequisites

1. **Docker running** — `./scripts/preview` builds a Debian image with sway, wayvnc, `wf-recorder`, `wtype`, and `wlrctl`.
2. **Preview started for the worktree you want to record**:
   ```bash
   ./scripts/preview                       # or: ./scripts/preview <worktree>
   ```
   Leave it running. The entrypoint sets `AGENTWFY_PREVIEW_CURSOR=1`, which enables the Electron-level cursor overlay the drivers rely on.
3. **Worktree directory name** — the preview name is the sanitized directory basename (see `./scripts/preview --list`). The rest of this doc uses `<name>` as a placeholder; substitute `cozy-squishing-sunset` or whatever applies.

## Recording a demo

Once the preview is up:

```bash
./scripts/record-demo <name> demos/<demo>
```

`record-demo` handles the full orchestration:

1. Wipes `/tmp/preview-config.json` so the starting theme / provider / whatever is the defaults.
2. Restarts the app so the UI is in a known state.
3. Inserts the `test-provider` plugin (demos drive a fake provider so they don't need real API keys).
4. Shows the overlay cursor parked at the bottom-right.
5. Starts `wf-recorder` writing to `/tmp/preview-recording.mp4` in the container.
6. Runs `demos/<demo>/driver.js` with `PREVIEW_NAME` and `WORKTREE` in its env.
7. Sends SIGINT to `wf-recorder` (so the MP4 `moov` atom flushes cleanly) and copies the file out to `demos/<demo>/demo.mp4`.

If the driver exits non-zero, the recorder is still stopped so the container isn't left with an orphaned `wf-recorder` process.

## Writing a driver

`driver.js` is a Node script. It gets `PREVIEW_NAME` in the env, is called from the worktree root, and drives the app through helpers exported from `scripts/lib/demo.mjs`:

```js
#!/usr/bin/env node
import { evalMain, evalPalette, installCursorHelpers, sleep } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
await installCursorHelpers(NAME);

evalMain(NAME, `(async () => {
  const d = window.__demo;      // helpers installed by installCursorHelpers
  await d.moveToEl(document.querySelector('textarea#msg-input'), 100, 22);
  await d.clickEl(document.querySelector('textarea#msg-input'));
  await d.typeInto(document.querySelector('textarea#msg-input'), 'tools');
  // ...
  return 'ok';
})()`);
```

What `installCursorHelpers(name)` installs on `window.__demo` (persists across subsequent `evalMain` calls in the same page):

| Helper | What it does |
|---|---|
| `d.x`, `d.y` | Current cursor position. Survives across `evalMain` calls. |
| `d.moveTo(x, y, dur?)` | Interpolated cursor motion with ease-in-out, one IPC call per frame. |
| `d.moveToEl(el, xOff?, yOff?, dur?)` | `moveTo` to the element's center (or with offsets). |
| `d.clickEl(el)` | Rippleflash + dispatch full `mousedown` / `mouseup` / `click` at the current cursor position. |
| `d.clickSelector(sel, ...)` | `moveToEl` + `clickEl` on `document.querySelector(sel)`. |
| `d.typeInto(el, text, perChar?)` | Native-setter + `InputEvent` typing into a `<textarea>` or `<input>`. |
| `d.waitFor(selectorOrFn, timeoutMs?)` | Poll until an element appears (or a function returns truthy). |
| `d.ripple(x, y)` | Standalone click-flash. |

Wrappers exported by `scripts/lib/demo.mjs`:

- `evalMain(name, js)` — runs the expression in the **main renderer** (the `app://` page). `window.ipc` is the full IPC surface.
- `evalPalette(name, js)` — runs in the **command palette's own** WebContentsView (`command_palette.html`). Use this to drive the palette's DOM directly (fill its searchInput, click its inner buttons, dispatch Escape to close).
- `exec(name, ...cmd)` — arbitrary `docker exec` inside the container. Handy for `cat /tmp/preview-config.json` etc. during iteration.
- `sleep(ms)`.

Preview-only extras that are already wired into `window.ipc` and that `installCursorHelpers` uses:

- `window.ipc.previewCursor.setPos(x, y)` — absolute viewport coords. Positions the Electron-level cursor overlay that renders above every tab view.
- `window.ipc.previewCursor.setVisible(bool)`.

Everything else is normal app IPC.

### Cursor overlay

Headless wlroots exposes no pointer device, so sway never renders a real cursor. The app creates a transparent `WebContentsView` above every tab view that carries a macOS-style black arrow. `window.ipc.previewCursor` positions it.

CDP-dispatched mouse events **do not move the OS cursor**, and moving the overlay **does not fire DOM events**. A "click" is two separate operations: animate the overlay over the target, then dispatch synthetic `mousedown` / `mouseup` / `click` events on the element. Several app handlers (provider card, tool header, popup close) listen on `mousedown` only — always dispatch the full sequence. `d.clickEl` does both.

`installCursorHelpers` tracks the current cursor position on `window.__demo.{x,y}`. Because the main-renderer page persists across every `evalMain` call, subsequent segments read the last known position and continue motion from there without needing to restate it.

### Driving the command palette

The palette is a separate WebContentsView with its own DOM. Drive it with `--eval --tab command_palette.html` rather than adding new main-process IPC:

- **Open at a screen**: `window.ipc.commandPalette.show({ screen: 'settings' })` (main renderer).
- **Type into the palette filter**: on the palette side, focus `#searchInput` and dispatch `input` events with `InputEvent` using the native value setter — same pattern as typing into the chat textarea.
- **Fire an item**: dispatch `KeyboardEvent{key:'Enter'}` on `#searchInput`. The palette's own handlers run the selected action, which usually auto-closes the palette.
- **Click inside the palette (e.g. Save / Cancel / target buttons)**: find the button by text or `data-*` and call `.click()`.
- **Close the palette**: dispatch two Escape `KeyboardEvent`s on the palette document — one per screen level pushed.

### Driving features

| Feature | How |
|---|---|
| Select a provider | In main: `document.querySelector('.provider-card[data-provider-id="test-provider"]')`, dispatch `mousedown`. |
| Send a chat message | In main: set `textarea#msg-input` value via the native `HTMLTextAreaElement.prototype.value` setter, dispatch `InputEvent`, then `KeyboardEvent{key:'Enter'}`. |
| Tool trace popup | In main: click `.tool-header[data-tool-id]`. Wait for streaming to finish (`.composer-stop` hidden) before clicking, or the popup race-conditions with the message re-render. Close with `.tool-popup-close`. |
| Open a view as a tab | In main (direct): `window.ipc.tabs.openTab({ viewName: 'system.source-explorer' })`. In palette: type the view name into `#searchInput`, then Enter. |
| Command palette, settings screen | In main: `window.ipc.commandPalette.show({ screen: 'settings' })`. In palette: type into the filter (`#searchInput`), flip the target to Global/Agent if needed (`.settings-target-btn[data-target="global"]`), type the value into `.settings-card[data-setting-key="..."] input.settings-card-input`, click the `Save` button. |
| Theme flip to dark | Palette settings flow above with `data-setting-key="system.theme"` and value `dark`. Applies live (no reload) once the app processes the palette's Save. |
| Zen mode | `window.ipc.zenMode.set(true)` / `set(false)`. |
| Chat ↔ Tasks panel switcher | `.awfy-app-sidebar-switcher-btn[data-panel="tasks"]` / `[data-panel="agent-chat"]`. |
| Tasks panel sub-tabs (Runs / Tasks / Triggers) | Shadow DOM. `document.querySelector('awfy-task-panel').shadowRoot.querySelector('.tab[data-tab="triggers"]')`. |
| Collapse / re-open sidebar | `.awfy-app-sidebar-toggle` to collapse, `.awfy-app-inline-toggle` to restore. |

### Timing and pacing

- Cursor moves: 600–900 ms feels natural. Shorter feels jumpy.
- Between a click and the next cursor move: `sleep(400)` lets the UI redraw.
- Streaming responses from `test-provider`'s `tools` command take ~5 s. Don't poll on `.tool-header` alone — it appears mid-stream; wait for `.composer-stop` to disappear too.
- Keep the first on-screen motion after recording starts at least 400 ms in, so `wf-recorder` is definitely capturing before anything interesting happens.
- After a palette `Save` that changes theme, give `~1 s` for the renderer to repaint before the next step.

## Adding a new demo

1. Create `demos/<new-name>/` with `driver.js` (chmod +x). Reuse the cursor helpers from an existing driver.
2. Record:
   ```bash
   ./scripts/record-demo <preview-name> demos/<new-name>
   ```
3. Scrub the output; iterate on the driver if clicks miss or pacing feels off.
4. Commit `driver.js` and `demo.mp4` together.

## Existing demos

- **`demos/chat-and-trace/`** (~15 s) — provider selection, message send, tool trace popup open/close, Source Explorer tab via direct `openTab`, cursor drift over tab content.
- **`demos/full-tour/`** (~36 s) — chat flow plus: Source Explorer via command palette (natively-typed filter), zen mode, chat ↔ tasks ↔ triggers panels, sidebar collapse/restore, and palette Settings flow (Global target, type `dark`, Save) with the live light→dark theme flip.

## Troubleshooting

- **`./scripts/record-demo` says "No preview named …"** — `./scripts/preview` isn't running for this worktree. Start it first.
- **Video file is tiny (< 50 KB) or won't play** — `wf-recorder` didn't see a mapped output. Usually means the preview's Electron window didn't come up; check `./scripts/preview --logs <name> -n 30`.
- **Driver throws `Cannot read properties of undefined (reading 'previewCursor')`** — the preview is running an image built before the overlay feature landed. Rebuild: `./scripts/preview --stop <name> && ./scripts/preview`.
- **Clicks on a provider card or a settings button do nothing** — that handler listens on `mousedown`. Dispatch the full `mousedown` / `mouseup` / `click` sequence, not just `element.click()`.
- **Tool-header click opens the popup then the popup disappears** — you clicked while the message was still streaming. `waitFor` both `.tool-header[data-tool-id]` AND `.composer-stop` being hidden before clicking.
- **Theme flip doesn't apply** — the palette's `Save` only writes when the target is Global or Agent; Default never persists. Click `.settings-target-btn[data-target="global"]` before typing the value.
- **Palette stays open after Save** — the palette never auto-closes on Save, only on action fire (Enter) or Escape. Dispatch Escape on the palette document to pop it.
