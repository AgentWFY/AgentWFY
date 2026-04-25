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

import { evalMain, installCursorHelpers } from '../../scripts/lib/demo.mjs';

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

  // Wait for the full stream to finish — both tool calls and the outro.
  await d.waitFor('.tool-header[data-tool-id]', 15000);
  await d.waitFor(
    () => document.querySelectorAll('.tool-header[data-tool-id]').length >= 2,
    15000,
  );
  await d.waitFor(
    () => !document.querySelector('.composer-stop:not([style*="display: none"])'),
    15000,
  );
  await d.sleep(700);

  // 3) Open the first tool popup (the multi-call exec, succeeds overall)
  const tools = document.querySelectorAll('.tool-header[data-tool-id]');
  if (tools[0]) {
    await d.moveToEl(tools[0], 30, null, 700);
    await d.clickEl(tools[0]);
    await d.waitFor('.tool-popup-overlay:not([hidden])', 3000);
    await d.sleep(2400);

    // Hover the Copy button next to "Code" to highlight it
    const codeCopy = document.querySelector('.tool-popup-body .tp-section .tp-copy[data-copy="code"]');
    if (codeCopy) {
      await d.moveToEl(codeCopy, null, null, 600);
      await d.sleep(600);
    }
    await d.clickSelector('.tool-popup-close', null, null, 700);
    await d.sleep(500);
  }

  // 4) Open the second tool popup (this one fully errored — shows red card)
  const tools2 = document.querySelectorAll('.tool-header[data-tool-id]');
  if (tools2[1]) {
    await d.moveToEl(tools2[1], 30, null, 700);
    await d.clickEl(tools2[1]);
    await d.waitFor('.tool-popup-overlay:not([hidden])', 3000);
    await d.sleep(2200);
    await d.clickSelector('.tool-popup-close', null, null, 700);
    await d.sleep(450);
  }

  // 5) Open the trace panel via the toolbar button
  const traceBtn = document.querySelector('awfy-agent-chat .icon-btn[title="Function trace"]');
  if (traceBtn) {
    await d.moveToEl(traceBtn, null, null, 700);
    await d.clickEl(traceBtn);
    await d.waitFor('awfy-trace-panel:not([hidden])', 3000);
    await d.sleep(2200);

    // Drill into the first call of the first (multi-call) exec — pick
    // the failing one if we can find it, otherwise the first.
    const erroredCall = document.querySelector('awfy-trace-panel .tr-call.errored[data-call-drill]');
    const firstCall = document.querySelector('awfy-trace-panel .tr-call[data-call-drill]');
    const target = erroredCall || firstCall;
    if (target) {
      await d.moveToEl(target, 60, null, 800);
      await d.clickEl(target);
      await d.waitFor('awfy-trace-panel .tr-det-body', 3000);
      await d.sleep(2600);

      // Back to list
      const back = document.querySelector('awfy-trace-panel .tr-back');
      if (back) {
        await d.moveToEl(back, null, null, 700);
        await d.clickEl(back);
        await d.sleep(900);
      }
    }

    // 6) Toggle the Errors filter (only present when there are errors)
    const errChip = document.querySelector('awfy-trace-panel .tr-chip.err');
    if (errChip) {
      await d.moveToEl(errChip, null, null, 700);
      await d.clickEl(errChip);
      await d.sleep(1700);
      // Flip back to All
      const allChip = document.querySelector('awfy-trace-panel .tr-chip:not(.err)');
      if (allChip) {
        await d.moveToEl(allChip, null, null, 600);
        await d.clickEl(allChip);
        await d.sleep(1000);
      }
    }

    // Close the trace panel
    const closeBtn = document.querySelector('awfy-trace-panel .tr-icon-btn[data-close]');
    if (closeBtn) {
      await d.moveToEl(closeBtn, null, null, 600);
      await d.clickEl(closeBtn);
      await d.sleep(600);
    }
  }

  await window.ipc.previewCursor.setVisible(false);
  return 'ok';
})()`);
