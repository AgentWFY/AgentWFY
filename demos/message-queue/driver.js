#!/usr/bin/env node
// Message-queue demo: while the agent is busy working on a turn, send
// several follow-up messages. Instead of vanishing until their turn comes
// up, they appear stacked above the composer as a "Queued" list. Cancel one
// from the queue, then let the turn finish so the rest drain into the
// conversation one after another.
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, installCursorHelpers, sleep } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

await installCursorHelpers(NAME);

// 1) Select the test provider and start a long-running turn. "thinking"
//    keeps the agent busy ~15s with a live "thinking… Ns" status line.
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.sleep(500);

  const card = await d.waitFor('.provider-card[data-provider-id="test-provider"]', 4000);
  if (card) {
    await d.moveToEl(card, 180, 40, 800);
    await d.clickEl(card);
    await d.sleep(400);
  }

  const ta = await d.waitFor('textarea#msg-input', 3000);
  await d.moveToEl(ta, 100, 22, 600);
  await d.clickEl(ta);
  await d.typeInto(ta, 'thinking', 70);
  await d.sleep(300);
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));
  return 'turn-started';
})()`);

// Let the turn begin (isStreaming === true; placeholder flips to follow-up).
await sleep(1300);

// 2) The whole queue-then-cancel choreography runs as ONE renderer eval so
//    the pacing is deterministic (no per-step docker round-trips). The
//    "thinking" turn only re-renders ~1x/sec, so a longer eval is safe.
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const enter = (ta) => ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
  }));
  const followUps = [
    'Summarize the totals at the end',
    'Group them into odds and evens',
    'Save the summary as a note',
  ];

  // Send each follow-up — they pile up in the queue above the composer.
  for (const text of followUps) {
    const ta = document.querySelector('textarea#msg-input');
    await d.moveToEl(ta, 90, 18, 360);
    await d.clickEl(ta);
    await d.typeInto(ta, text, 16);
    await d.sleep(220);
    enter(ta);
    await d.sleep(820);
  }

  // Hold the full queue of three on screen for a beat.
  await d.sleep(1100);

  // Change of mind — cancel the middle queued message via its × button.
  const cancels = document.querySelectorAll('.queue-item-cancel');
  const btn = cancels[1] || cancels[0];
  if (btn) {
    await d.moveToEl(btn, 0, 0, 600);
    await d.sleep(450);
    await d.clickEl(btn);
  }

  // Let the two-item queue sit on screen so the removal is clearly visible.
  await d.sleep(2000);
  await d.moveTo(d.x - 30, d.y - 150, 700);
  return 'queued-and-trimmed';
})()`);

// 3) Wait out the rest of the turn. When it finishes, the two remaining
//    queued messages drain into the conversation one after another and the
//    queue clears itself.
await sleep(8500);

evalMain(NAME, `(async () => {
  window.ipc.previewCursor.setVisible(false);
  return 'done';
})()`);
