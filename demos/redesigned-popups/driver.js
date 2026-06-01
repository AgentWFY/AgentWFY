#!/usr/bin/env node
// Demo for the redesigned tool-call popup and trace panel.
//
// Flow:
//   1. Pick the test provider
//   2. Send "trace-demo" — runs an exec_js with three runSql calls
//      (one of them errors) plus a second exec_js that fully fails
//   3. Open the first tool's popup → shows status pill, code, return
//      value, console logs (new design)
//   4. Open the second tool's popup → shows the promoted red error card
//   5. Open the function-trace panel → list view with stats, per-exec
//      mini waterfalls and call rows
//   6. Drill into the failing runSql call → full-panel detail with
//      badges, params, error card, code
//   7. Back, then toggle the Errors filter → only the failing exec
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, installCursorHelpers, sleep } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

await installCursorHelpers(NAME);

evalMain(NAME, `(async () => {
  const d = window.__demo;

  await d.sleep(500);

  // 1) Select the test provider
  const card = await d.waitFor('.provider-card[data-provider-id="test-provider"]', 4000);
  if (card) {
    await d.moveToEl(card, 180, 40, 800);
    await d.clickEl(card);
    await d.sleep(450);
  }

  // 2) Type "trace-demo" and send
  const ta = await d.waitFor('textarea#msg-input', 3000);
  await d.moveToEl(ta, 100, 22, 600);
  await d.clickEl(ta);
  await d.typeInto(ta, 'trace-demo', 75);
  await d.sleep(350);
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));
  return 'sent';
})()`);

await sleep(3500);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  const tools = document.querySelectorAll('.tool-header');
  if (tools[0]) {
    await d.moveToEl(tools[0], 30, null, 500);
    await d.clickEl(tools[0]);
  }
  return 'first-popup-opened';
})()`);

await sleep(2400);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  const codeCopy = document.querySelector('.tool-popup-body .tp-section .tp-copy[data-copy="code"]');
  if (codeCopy) {
    await d.moveToEl(codeCopy, null, null, 500);
    await d.sleep(500);
  }
  await d.clickSelector('.tool-popup-close', null, null, 500);
  return 'first-popup-closed';
})()`);

await sleep(500);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  const tools2 = document.querySelectorAll('.tool-header');
  if (tools2[1]) {
    await d.moveToEl(tools2[1], 30, null, 500);
    await d.clickEl(tools2[1]);
  }
  return 'second-popup-opened';
})()`);

await sleep(2200);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.clickSelector('.tool-popup-close', null, null, 500);
  return 'second-popup-closed';
})()`);

await sleep(500);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  const traceBtn = document.querySelector('awfy-agent-chat .icon-btn[title="Function trace"]');
  if (traceBtn) {
    await d.moveToEl(traceBtn, null, null, 500);
    await d.clickEl(traceBtn);
  }
  return 'trace-opened';
})()`);

await sleep(2200);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  const erroredCall = document.querySelector('awfy-trace-panel .tr-call.errored[data-call-drill]');
  const firstCall = document.querySelector('awfy-trace-panel .tr-call[data-call-drill]');
  const target = erroredCall || firstCall;
  if (target) {
    await d.moveToEl(target, 60, null, 600);
    await d.clickEl(target);
  }
  return 'trace-drilled';
})()`);

await sleep(2600);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  const back = document.querySelector('awfy-trace-panel .tr-back');
  if (back) {
    await d.moveToEl(back, null, null, 500);
    await d.clickEl(back);
  }
  return 'trace-back';
})()`);

await sleep(900);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  const errChip = document.querySelector('awfy-trace-panel .tr-chip.err');
  if (errChip) {
    await d.moveToEl(errChip, null, null, 500);
    await d.clickEl(errChip);
    await d.sleep(800);
  }
  const closeBtn = document.querySelector('awfy-trace-panel .tr-icon-btn[data-close]');
  if (closeBtn) {
    await d.moveToEl(closeBtn, null, null, 500);
    await d.clickEl(closeBtn);
  }
  window.ipc.previewCursor.setVisible(false);
  return 'ok';
})()`);
