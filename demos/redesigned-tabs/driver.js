#!/usr/bin/env node
// Demo for the redesigned tab bar.
//
// Flow:
//   1. Open a mix of tabs (view, file, URL).
//   2. Pin a tab → 28×28 pin icon visible at the start of the strip.
//   3. Click between tabs in compact 30px mode (panel updates visibly).
//   4. Hover an inactive tab → close × in the right-side status slot.
//   5. Open the command palette at the Settings screen, filtered to
//      "show-tab-source"; click the "agent" target button, type "true",
//      press Enter to save. Header smoothly grows from 30 → 42px and
//      tabs become two-line.
//   6. Click between tabs in two-line mode.
//   7. UPDATE the demo-notes view → accent dot in the right slot.
//   8. Hover the changed tab → × replaces the dot.
//   9. Open the palette again, set show-tab-source back to default → bar
//      collapses to compact.
//  10. Close the chat panel → inline panel-toggle button appears at the
//      left of the tabs, vertically aligned with the pin icon.
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { spawnSync } from 'node:child_process';
import { evalMain, evalPalette, installCursorHelpers, sleep } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

// Wipe agent-side overrides for system.show-tab-source so the recording
// always starts in the default (compact) mode regardless of what the
// previous run left in agent.db. Done via --sqlite (not evalMain) so it
// completes before any frame the cursor renders into.
spawnSync('./scripts/preview', ['--sqlite', NAME,
  "UPDATE config SET value = NULL WHERE name = 'system.show-tab-source'"], { stdio: 'ignore' });
// Give the renderer's config-db-changed listener a beat to repaint the bar.
await sleep(700);

await installCursorHelpers(NAME);

// === Phase 1: setup + open tabs + pin + click around in compact mode ===
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const ipc = window.ipc;

  // Reset to compact mode at the start.
  await ipc.sql.run({
    target: 'agent',
    sql: "UPDATE config SET value = NULL WHERE name = 'system.show-tab-source'",
  });
  await d.sleep(300);

  // User-owned view we can mutate later for the changed-state demo.
  await ipc.sql.run({
    target: 'agent',
    sql: "INSERT OR REPLACE INTO views (name, title, content) VALUES (?, ?, ?)",
    params: [
      'demo-notes',
      'Notes',
      '<!doctype html><html><body style="font-family:sans-serif;padding:60px;color:#444;line-height:1.6"><h1>Notes</h1><p>This view will be updated mid-demo to trigger the changed-state dot.</p></body></html>',
    ],
  });
  await d.sleep(200);

  const t1 = await ipc.tabs.openTab({ viewName: 'system.docs' });
  await d.sleep(200);
  await ipc.tabs.openTab({ viewName: 'system.openai-compatible-provider.settings-view' });
  await d.sleep(200);
  await ipc.tabs.openTab({ viewName: 'demo-notes' });
  await d.sleep(200);
  await ipc.tabs.openTab({ url: 'https://www.anthropic.com/news' });
  await d.sleep(700);

  // Pin Docs so its 28×28 pin icon is visible.
  await ipc.tabs.togglePin(t1.tabId);
  await d.sleep(800);

  const click = async (idx) => {
    const tab = document.querySelectorAll('.tab-bar .tab-item:not(.pinned)')[idx];
    if (!tab) return;
    await d.moveToEl(tab, null, null, 600);
    await d.clickEl(tab);
    await d.sleep(700);
  };
  await click(0); // Provider Settings
  await click(1); // Notes
  await click(2); // Web Page
  await d.sleep(400);

  // Hover an inactive tab to reveal the close ×.
  const hoverTab = document.querySelectorAll('.tab-bar .tab-item:not(.pinned)')[0];
  if (hoverTab) {
    await d.moveToEl(hoverTab, null, null, 600);
    await d.sleep(900);
  }
  return 'phase1-done';
})()`);

// === Phase 2: open the command palette and toggle show-tab-source on ===
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const ipc = window.ipc;
  // Move cursor toward the centre so it's near where the palette pops up.
  await d.moveTo(700, 320, 800);
  await d.sleep(200);
  await ipc.commandPalette.show({ screen: 'settings', params: { filter: 'show-tab-source' } });
  return 'palette-opened';
})()`);

await sleep(900);

evalPalette(NAME, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(400);
  const card = document.querySelector('.settings-card[data-setting-key="system.show-tab-source"]');
  if (!card) return JSON.stringify({ error: 'no card' });

  const agentBtn = card.querySelector('.settings-target-btn[data-target="agent"]');
  if (agentBtn) { agentBtn.click(); await sleep(400); }

  const input = card.querySelector('.settings-card-input');
  if (input) {
    input.focus();
    const proto = HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(input, '');
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    for (const ch of 'true') {
      set.call(input, input.value + ch);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await sleep(140);
    }
    await sleep(500);
    const saveBtn = document.querySelector('[data-action="save"]');
    if (saveBtn) { saveBtn.click(); await sleep(900); }
  }
  await window.commandPaletteBridge.close();
  return 'saved';
})()`);

// Wait for the palette's WebContentsView hide + the bar's height
// transition to fully settle before any subsequent cursor move starts
// drawing on top of the area the palette just vacated.
await sleep(1400);

// === Phase 3: click between tabs in two-line mode ===
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const click = async (idx) => {
    const tab = document.querySelectorAll('.tab-bar .tab-item:not(.pinned)')[idx];
    if (!tab) return;
    await d.moveToEl(tab, null, null, 600);
    await d.clickEl(tab);
    await d.sleep(700);
  };
  await click(0);
  await click(1);
  await click(2);
  await d.sleep(500);
  return 'phase3-done';
})()`);

// === Phase 4: trigger viewChanged + hover demo ===
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const ipc = window.ipc;
  await ipc.sql.run({
    target: 'agent',
    sql: "UPDATE views SET content = ? WHERE name = ?",
    params: [
      '<!doctype html><html><body style="font-family:sans-serif;padding:60px;color:#444;line-height:1.6"><h1>Notes — updated</h1><p>The right-side status slot now shows the accent dot until the view is reloaded.</p></body></html>',
      'demo-notes',
    ],
  });
  await d.sleep(700);

  const click = async (idx) => {
    const tab = document.querySelectorAll('.tab-bar .tab-item:not(.pinned)')[idx];
    if (!tab) return;
    await d.moveToEl(tab, null, null, 600);
    await d.clickEl(tab);
    await d.sleep(700);
  };
  await click(2); // Web Page so Notes is inactive

  const notes = Array.from(document.querySelectorAll('.tab-bar .tab-item'))
    .find(el => el.classList.contains('changed'));
  if (notes) {
    const r = notes.getBoundingClientRect();
    await d.moveTo(r.left + r.width / 2, r.top + r.height + 60, 700);
    await d.sleep(1100);
    await d.moveToEl(notes, null, null, 700);
    await d.sleep(1300);
    await d.moveTo(r.left + r.width / 2, r.top + r.height + 60, 600);
    await d.sleep(700);
  }
  return 'phase4-done';
})()`);

// === Phase 5: open palette again, clear back to default ===
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const ipc = window.ipc;
  await d.moveTo(700, 320, 700);
  await ipc.commandPalette.show({ screen: 'settings', params: { filter: 'show-tab-source' } });
  return 'palette-2-opened';
})()`);

await sleep(900);

evalPalette(NAME, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(400);
  const card = document.querySelector('.settings-card[data-setting-key="system.show-tab-source"]');
  if (!card) return 'no card';

  // Click the "default" target button to clear the override.
  const defaultBtn = card.querySelector('.settings-target-btn[data-target="default"]');
  if (defaultBtn) { defaultBtn.click(); await sleep(500); }

  // Click the Save button in the footer to commit the change.
  const saveBtn = document.querySelector('[data-action="save"]');
  if (saveBtn) { saveBtn.click(); await sleep(700); }

  await window.commandPaletteBridge.close();
  return 'cleared';
})()`);

await sleep(1400);

// === Phase 6: close chat panel to show the inline toggle alongside pin ===
evalMain(NAME, `(async () => {
  const d = window.__demo;
  window.dispatchEvent(new CustomEvent('agentwfy:toggle-agent-chat'));
  await d.sleep(1000);

  const inlineToggle = document.querySelector('.awfy-app-inline-toggle.visible');
  if (inlineToggle) {
    await d.moveToEl(inlineToggle, null, null, 700);
    await d.sleep(1100);
  }

  // Reopen so the closing frame is calm.
  window.dispatchEvent(new CustomEvent('agentwfy:toggle-agent-chat'));
  await d.sleep(700);

  await window.ipc.previewCursor.setVisible(false);
  return 'done';
})()`);
