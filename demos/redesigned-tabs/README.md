# redesigned-tabs

Demo of the redesigned tab bar.

## What this demo shows

1. Default **compact** (single-line, 28px) tab strip with a mix of view, file
   and URL tabs. No icons; just the title.
2. Hover a tab — the close × fades in inside the right-side status slot.
3. Toggle `system.show-tab-source` to `true`. The bar reacts live (no app
   restart) and switches to the **full** (two-line) layout: title on top,
   monospace source target below — the view name, file path, or URL.
4. Trigger a view-source change. The right-side status slot shows the
   accent-color "needs reload" dot.
5. Hover the changed tab — × replaces the dot in the same slot. Title
   position never shifts.
6. Toggle the config back off; the bar collapses to compact.

## Recording

```bash
./scripts/preview                       # start (or have running) the worktree preview
./scripts/record-demo <preview-name> demos/redesigned-tabs
```

The orchestrator wipes preview state, restarts the app, runs `driver.js`,
and writes `demo.mp4` next to the driver. See `docs/RECORDING_DEMOS.md`
for the full pipeline.
