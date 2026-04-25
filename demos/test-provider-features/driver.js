#!/usr/bin/env node
// Test-Provider features demo. Walks the full command list from
// plugins/test-provider/docs/plugin.test-provider.md so each failure
// mode and streaming behavior is visible on screen:
//
//   normal     — thinking stream + text stream
//   tools      — assistant turn with an execJs tool call, open + close trace popup
//   slow       — 1 token/second streaming (watchdog stays quiet)
//   thinking   — server-side "thinking" with status_line keepalives
//   ratelimit  — rate_limit error with retryAfterMs countdown, Stop
//   network    — retryable network error banner, Stop
//   multi-fail — 3 retry failures, compressed via "Retry now", 4th succeeds
//   auth       — non-retryable error, no retry banner
//   overflow   — context_overflow error
//
// Skipped:
//   timeout    — requires ~30s of silence for the watchdog to display
//   abort-tools — not in the public command list
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, installCursorHelpers, sleep } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

await installCursorHelpers(NAME);

// --- 1. Select Test Provider ------------------------------------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.sleep(400);
  const card = await d.waitFor('.provider-card[data-provider-id="test-provider"]', 3000);
  if (card) {
    await d.moveToEl(card, 180, 40, 900);
    await d.clickEl(card);
    await d.sleep(500);
  }
  return 'ok';
})()`);

// Shared helper: type a command into the composer and press Enter. We
// install it on window.__demo once so each step below is a one-liner.
evalMain(NAME, `(async () => {
  const d = window.__demo;

  d.send = async (cmd, perChar = 45) => {
    const ta = await d.waitFor('textarea#msg-input', 3000);
    await d.moveToEl(ta, 120, 22, 500);
    await d.clickEl(ta);
    // Clear any residual text from a previous send.
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

  // True once streaming stops (composer-stop hidden).
  d.notStreaming = () => !document.querySelector('.composer-stop:not([style*="display: none"])');
  d.retryVisible = () => {
    const el = document.querySelector('.retry-banner');
    return el && el.style.display !== 'none' && el.querySelector('.retry-text');
  };
  d.errorVisible = () => {
    const el = document.querySelector('.error-banner');
    return el && el.style.display !== 'none' && (el.textContent || '').trim();
  };

  d.clickRetryBannerBtn = async (action) => {
    const btn = document.querySelector('.retry-banner button[data-action="' + action + '"]');
    if (!btn) return false;
    await d.moveToEl(btn, null, null, 500);
    await d.clickEl(btn);
    return true;
  };

  d.clickStopBtn = async () => {
    const btn = document.querySelector('.composer-stop');
    if (!btn || btn.style.display === 'none') return false;
    await d.moveToEl(btn, null, null, 500);
    await d.clickEl(btn);
    return true;
  };

  // True when nothing is in flight: not streaming AND no retry banner.
  d.idle = () => d.notStreaming() && !d.retryVisible();
  return 'ok';
})()`);

// --- 2. "normal" — thinking + text streaming --------------------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('normal');
  await d.waitFor(d.notStreaming, 15000);
  await d.sleep(600);
  return 'ok';
})()`);

// --- 3. "tools" — tool call + trace popup -----------------------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('tools');
  await d.waitFor('.tool-header[data-tool-id]', 15000);
  await d.waitFor(d.notStreaming, 15000);
  await d.sleep(400);
  const toolHeader = document.querySelector('.tool-header[data-tool-id]');
  if (toolHeader) {
    await d.moveToEl(toolHeader, 30, null, 700);
    await d.clickEl(toolHeader);
    await d.waitFor('.tool-popup-overlay', 3000);
    await d.sleep(1800);
    await d.clickSelector('.tool-popup-close', null, null, 500);
    await d.sleep(400);
  }
  return 'ok';
})()`);

// --- 4. "slow" — 1 token per second -----------------------------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('slow');
  await d.waitFor(d.notStreaming, 20000);
  await d.sleep(500);
  return 'ok';
})()`);

// --- 5. "thinking" — server-side thinking with status keepalives ------
// Lets the waiting indicator and the "Test Provider · thinking... Ns"
// status line tick for a few seconds, then aborts so we don't pay the
// full 15s (the mechanism is visible within ~4s).
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('thinking');
  await d.sleep(4500);
  await d.clickStopBtn();
  await d.waitFor(d.notStreaming, 5000);
  await d.sleep(500);
  return 'ok';
})()`);

// --- 6. "ratelimit" — retryable with retryAfterMs, Stop ---------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('ratelimit');
  await d.waitFor(d.retryVisible, 10000);
  await d.sleep(2200); // let the countdown tick visibly
  await d.clickRetryBannerBtn('stop-retry');
  await d.waitFor(d.idle, 5000);
  await d.sleep(500);
  return 'ok';
})()`);

// --- 7. "network" — retryable mid-stream error, Stop ------------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('network');
  await d.waitFor(d.retryVisible, 15000);
  await d.sleep(1800);
  await d.clickRetryBannerBtn('stop-retry');
  await d.waitFor(d.idle, 5000);
  await d.sleep(500);
  return 'ok';
})()`);

// --- 8. "multi-fail" — fails 3×, 4th succeeds, compressed via Retry now
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('multi-fail');
  // Three failures, click "Retry now" after each banner shows so the
  // 5s/10s/20s backoffs don't stretch the demo past reason.
  for (let i = 0; i < 3; i++) {
    await d.waitFor(d.retryVisible, 20000);
    await d.sleep(900);
    await d.clickRetryBannerBtn('retry-now');
    await d.sleep(400);
  }
  // 4th attempt streams the success message.
  await d.waitFor(d.notStreaming, 20000);
  await d.sleep(800);
  return 'ok';
})()`);

// --- 9. "auth" — non-retryable error ----------------------------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('auth');
  await d.waitFor(d.errorVisible, 10000);
  await d.sleep(2400);
  return 'ok';
})()`);

// --- 10. "overflow" — context_overflow error --------------------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.send('overflow');
  await d.waitFor(d.errorVisible, 10000);
  await d.sleep(2400);
  return 'ok';
})()`);

// Park the cursor and hide it before we stop recording.
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.moveTo(1180, 640, 700);
  await window.ipc.previewCursor.setVisible(false);
  return 'ok';
})()`);
