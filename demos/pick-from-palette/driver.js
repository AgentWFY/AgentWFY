#!/usr/bin/env node
// Demo: pickFromPalette runtime function.
//
// Two segments:
//   1. Agent multi-choice — test provider emits an execJs tool call that
//      calls pickFromPalette; user picks; agent reports the choice.
//   2. Task picker — a task lists system views, calls pickFromPalette,
//      and opens the chosen view as a tab. Triggered from the command
//      palette "Run Task" flow.
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, evalPalette, installCursorHelpers, sleep, typeInPalette, clickInPalette } from '../../scripts/lib/demo.mjs';
import { spawnSync } from 'node:child_process';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

// Seed the demo task for segment 2 (the content double-escapes single
// quotes for SQL since they appear inside a SQL string literal).
spawnSync('./scripts/preview', ['--sqlite', NAME, `
INSERT OR REPLACE INTO tasks (name, title, description, content, timeout_ms)
VALUES ('pick-view-demo', 'Pick a System View',
        'List system views and let the user pick one to open',
        'const views = await runSql({ target: "agent", sql: "SELECT name, title FROM views WHERE name LIKE ''system.%'' ORDER BY name" }); const items = views.map(v => ({ title: v.title || v.name, subtitle: v.name, value: v.name })); const chosen = await pickFromPalette({ title: "Open System View", placeholder: "Search views…", items }); if (chosen) { await openTab({ viewName: chosen, title: chosen }); return "Opened " + chosen; } return "Cancelled";',
        30000);
`], { stdio: 'inherit' });

await installCursorHelpers(NAME);

// Install shared helpers on window.__demo
evalMain(NAME, `(async () => {
  const d = window.__demo;

  d.send = async (cmd, perChar = 45) => {
    const ta = await d.waitFor('textarea#msg-input', 3000);
    await d.moveToEl(ta, 120, 22, 500);
    await d.clickEl(ta);
    const proto = HTMLTextAreaElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(ta, '');
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    await d.typeInto(ta, cmd, perChar);
    await d.sleep(250);
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));
  };

  d.notStreaming = () => !document.querySelector('.composer-stop:not([style*="display: none"])');
  return 'ok';
})()`);

// ═══════════════════════════════════════════════════════════════
// Segment 1: Agent uses pickFromPalette via a tool call
// ═══════════════════════════════════════════════════════════════

evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.sleep(400);
  const card = await d.waitFor('.provider-card[data-provider-id="test-provider"]', 3000);
  if (card) { await d.moveToEl(card, 180, 40, 900); await d.clickEl(card); await d.sleep(500); }
  return 'ok';
})()`);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('pick');
  return 'ok';
})()`);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.waitFor('.tool-header[data-tool-id]', 15000);
  await d.moveTo(640, 320, 700);
  return 'ok';
})()`);

await sleep(1200);

await typeInPalette(NAME, 'Docs', 100);
await sleep(400);
evalPalette(NAME, `(async () => {
  document.getElementById('searchInput').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));
  return 'ok';
})()`);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.waitFor(d.notStreaming, 15000);
  await d.sleep(1500);
  return 'ok';
})()`);

// ═══════════════════════════════════════════════════════════════
// Segment 2: Task uses pickFromPalette via command palette
// ═══════════════════════════════════════════════════════════════

// Open palette to the normal screen, then navigate to "Run Task"
// by filtering and clicking the first result (show({screen:'tasks'})
// has a known timing issue, so we navigate manually).
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.moveTo(640, 360, 700);
  await window.ipc.commandPalette.show();
  return 'ok';
})()`);
await sleep(800);

// Filter to narrow the list to "Run Task" and click it
await typeInPalette(NAME, 'run task', 100);
await sleep(400);
await clickInPalette(NAME, '#results .item', { preClickDelay: 300, postClickDelay: 0 });
await sleep(900);

// Now on the tasks screen. Filter for the demo task and click it.
await typeInPalette(NAME, 'pick', 100);
await sleep(600);
await clickInPalette(NAME, '#results .item', { preClickDelay: 300, postClickDelay: 0 });
await sleep(900);

// Click the Run button on the task-detail screen.  Fires the run-task
// action: the palette hides, the task triggers pickFromPalette, and the
// palette reopens as a picker.
await clickInPalette(NAME, 'button[data-action="save"]', { preClickDelay: 300, postClickDelay: 0 });

// Host-side polling: wait for the picker to reopen with items.
for (let i = 0; i < 25; i++) {
  await sleep(800);
  const count = evalPalette(NAME, `document.querySelectorAll('#results .item').length`);
  if (typeof count === 'number' && count > 0) break;
}

// The picker is open. Filter for "source" and pick the Source Explorer.
await typeInPalette(NAME, 'source', 100);
await sleep(400);
evalPalette(NAME, `(async () => {
  document.getElementById('searchInput').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));
  return 'ok';
})()`);

// Let the tab open and settle
await sleep(2000);

// Park the cursor and hide it
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.moveTo(1180, 640, 700);
  await window.ipc.previewCursor.setVisible(false);
  return 'ok';
})()`);
