#!/usr/bin/env node
// Chat-and-trace demo: select Test Provider, send "tools", open and
// close the tool-trace popup, open Source Explorer as a page, drift the
// cursor over the page content to show the overlay staying on top.
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, installCursorHelpers, sleep } from '../../scripts/lib/demo.mjs';

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
  return 'sent';
})()`);

// Wait on the host side so a long renderer-side CDP eval cannot freeze while
// the chat stream re-renders.
await sleep(3500);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  const toolHeader = document.querySelector('.tool-header');
  if (toolHeader) {
    await d.moveToEl(toolHeader, 30, null, 600);
    await d.clickEl(toolHeader);
  }
  return 'popup-open-clicked';
})()`);

await sleep(2200);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.clickSelector('.tool-popup-close', null, null, 500);
  return 'popup-close-clicked';
})()`);

await sleep(600);

evalMain(NAME, `(async () => {
  const open = window.ipc.pages.openClientPage({
    source: { type: 'view', name: 'system.source-explorer' },
  });
  await Promise.race([open, new Promise(resolve => setTimeout(resolve, 1200))]);
  return 'tab-opening';
})()`);

await sleep(900);

evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.moveTo(860, 360, 900);
  await d.sleep(700);

  window.ipc.previewCursor.setVisible(false);
  return 'ok';
})()`);
