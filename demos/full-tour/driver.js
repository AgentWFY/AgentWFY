#!/usr/bin/env node
// Full tour of the app. Exercises:
//   - Test Provider selection + chat message + tool-trace popup
//   - Command palette with a natively-typed filter, opens Source Explorer
//   - Zen mode toggle
//   - Chat ↔ Tasks ↔ Triggers sidebar panels (Shadow-DOM Triggers sub-tab)
//   - Sidebar collapse + restore
//   - Command palette Settings screen: type "theme", flip target to
//     Global, type "dark", click Save — live light → dark theme flip
//
// All interaction inside the palette's own WebContentsView goes through
// evalPalette (CDP --eval --tab command_palette.html). No new IPC.
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, evalPalette, installCursorHelpers, sleep } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

await installCursorHelpers(NAME);

// --- 1. Chat + tool-trace popup ---------------------------------------
evalMain(NAME, `(async () => {
  const d = window.__demo;

  await d.sleep(400);

  const card = await d.waitFor('.provider-card[data-provider-id="test-provider"]', 3000);
  if (card) { await d.moveToEl(card, 180, 40, 900); await d.clickEl(card); await d.sleep(400); }

  const ta = await d.waitFor('textarea#msg-input', 3000);
  await d.moveToEl(ta, 100, 22, 600);
  await d.clickEl(ta);
  await d.typeInto(ta, 'tools', 100);
  await d.sleep(400);
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));

  await d.waitFor('.tool-header[data-tool-id]', 15000);
  await d.waitFor(() => !document.querySelector('.composer-stop:not([style*="display: none"])'), 10000);
  await d.sleep(400);
  const toolHeader = document.querySelector('.tool-header[data-tool-id]');
  if (toolHeader) {
    await d.moveToEl(toolHeader, 30, null, 700);
    await d.clickEl(toolHeader);
    await d.waitFor('.tool-popup-overlay', 3000);
    await d.sleep(1600);
    await d.clickSelector('.tool-popup-close', null, null, 600);
    await d.sleep(400);
  }
  return 'ok';
})()`);

// --- 2. Open Source Explorer via command palette ----------------------
// Move the cursor toward where the palette will show, then open it.
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await window.ipc.commandPalette.show();
  await d.moveTo(640, 360, 700);
  return 'ok';
})()`);
await sleep(0.6 * 1000);

// Type "source" into the palette's own searchInput (letter-by-letter)
// then fire Enter — the palette's keydown handler runs the selected
// action (opens Source Explorer tab + auto-closes the palette).
evalPalette(NAME, `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const input = document.getElementById('searchInput');
  input.focus();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const ch of 'source') {
    set.call(input, (input.value || '') + ch);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    await sleep(120);
  }
  await sleep(600);
  input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));
  return 'ok';
})()`);
await sleep(800);

// Drift into the tab content to prove the cursor overlay stays above
// the tab's WebContentsView.
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.moveTo(900, 380, 900);
  await d.sleep(700);
  return 'ok';
})()`);

// --- 3. Zen mode on / off ---------------------------------------------
evalMain(NAME, `window.ipc.zenMode.set(true)`);
await sleep(1600);
evalMain(NAME, `window.ipc.zenMode.set(false)`);
await sleep(800);

// --- 4. Chat → Tasks → Triggers → Chat + sidebar collapse -------------
evalMain(NAME, `(async () => {
  const d = window.__demo;

  await d.clickSelector('.awfy-app-sidebar-switcher-btn[data-panel="tasks"]', null, null, 600);
  await d.sleep(900);

  // Shadow DOM: reach into the task panel's root to click the Triggers tab.
  const panel = document.querySelector('awfy-task-panel');
  const triggersTab = panel?.shadowRoot?.querySelector('.tab[data-tab="triggers"]');
  if (triggersTab) {
    const r = triggersTab.getBoundingClientRect();
    await d.moveTo(r.left + r.width / 2, r.top + r.height / 2, 500);
    triggersTab.click();
    await d.sleep(1000);
  }

  await d.clickSelector('.awfy-app-sidebar-switcher-btn[data-panel="agent-chat"]', null, null, 600);
  await d.sleep(700);

  await d.clickSelector('.awfy-app-sidebar-toggle', null, null, 600);
  await d.sleep(1000);
  await d.clickSelector('.awfy-app-inline-toggle', null, null, 600);
  await d.sleep(700);
  return 'ok';
})()`);

// --- 5. Command palette → Settings → theme dark (natively via palette) -
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.moveTo(640, 200, 700);
  await window.ipc.commandPalette.show({ screen: 'settings' });
  return 'ok';
})()`);
await sleep(800);

evalPalette(NAME, `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const type = async (el, text, per = 110) => {
    el.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const ch of text) {
      set.call(el, (el.value || '') + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await sleep(per);
    }
  };
  await type(document.getElementById('searchInput'), 'theme');
  await sleep(500);
  const card = document.querySelector('.settings-card[data-setting-key="system.theme"]');
  card.scrollIntoView({ block: 'center' });
  await sleep(250);
  card.querySelector('.settings-target-btn[data-target="global"]').click();
  await sleep(300);
  await type(card.querySelector('input.settings-card-input'), 'dark', 130);
  await sleep(500);
  [...document.querySelectorAll('button.btn')].find(b => b.textContent.trim() === 'Save').click();
  await sleep(600);
  // Two Escapes pop the stacked settings screens and close the palette.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  await sleep(150);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  return 'ok';
})()`);
await sleep(1200);

evalMain(NAME, `window.ipc.previewCursor.setVisible(false)`);
