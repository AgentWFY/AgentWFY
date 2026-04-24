#!/usr/bin/env node
// Chat-and-trace demo: select Test Provider, send "tools", open and
// close the tool-trace popup, open Source Explorer as a tab, drift the
// cursor over the tab content to show the overlay staying on top.
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, installCursorHelpers } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

await installCursorHelpers(NAME);

evalMain(NAME, `(async () => {
  const d = window.__demo;

  await d.sleep(400);

  const card = await d.waitFor('.provider-card[data-provider-id="test-provider"]', 3000);
  if (card) {
    await d.moveToEl(card, 180, 40, 900);
    await d.clickEl(card);
    await d.sleep(500);
  }

  const ta = await d.waitFor('textarea#msg-input', 3000);
  await d.moveToEl(ta, 100, 22, 700);
  await d.clickEl(ta);
  await d.typeInto(ta, 'tools', 110);
  await d.sleep(400);
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));

  // Wait for the stream to fully land before clicking tool-header —
  // mid-stream clicks race the message re-render.
  await d.waitFor('.tool-header[data-tool-id]', 15000);
  await d.waitFor(() => !document.querySelector('.composer-stop:not([style*="display: none"])'), 10000);
  await d.sleep(500);

  const toolHeader = document.querySelector('.tool-header[data-tool-id]');
  if (toolHeader) {
    await d.moveToEl(toolHeader, 30, null, 800);
    await d.clickEl(toolHeader);
    await d.waitFor('.tool-popup-overlay', 3000);
    await d.sleep(2200);
    await d.clickSelector('.tool-popup-close', null, null, 700);
    await d.sleep(600);
  }

  // Open Source Explorer as a tab + drift into its content to prove
  // the cursor overlay stays above the tab's WebContentsView.
  await d.moveTo(720, 20, 800);
  await window.ipc.tabs.openTab({ viewName: 'system.source-explorer' });
  await d.sleep(900);
  await d.moveTo(860, 360, 900);
  await d.sleep(700);

  await window.ipc.previewCursor.setVisible(false);
  return 'ok';
})()`);
