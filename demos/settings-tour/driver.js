#!/usr/bin/env node
// Settings screen tour with natural cursor movement.
//
// Every mouse click is preceded by the cursor moving to the target and
// dwelling briefly (hover states are visible). Keyboard interactions
// (typing, arrow keys, Tab, Escape) are typed character-by-character
// with the cursor staying put.
//
// Covers the redesigned settings screen (collapsible groups, inline
// expand, scope toggle, dirty tracking, save/discard, keyboard nav).
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, evalPalette, installCursorHelpers, sleep, mark } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

await installCursorHelpers(NAME);

// ── Compute settings-palette view origin ─────────────────────────────
// The settings screen resizes the palette to 640×520 (SETTINGS_WIDTH/HEIGHT
// in settings.ts). The manager centers it horizontally (cw-width)/2 at
// y=max(40, ch*0.12). applyBounds adds 40px padding on each side.
// CSS body { padding: 40px } is included in getBoundingClientRect, so:
//   gx = viewX + rect.x + rect.w/2    where viewX = (cw-w)/2 - 40
const ws = evalMain(NAME, `({ w: window.innerWidth, h: window.innerHeight })`);
const SETTINGS_W = Math.min(640, ws.w - 40);
const VIEW_X = Math.floor((ws.w - SETTINGS_W) / 2) - 40;
const VIEW_Y = Math.max(40, Math.floor(ws.h * 0.12)) - 40;

// ── Helpers ──────────────────────────────────────────────────────────

function paletteRect(selector) {
  return evalPalette(NAME, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
}

/** Move cursor over a palette element, dwell, ripple, then click.
 *  Returns false gracefully if the element isn't found. */
function clickInSettingsPalette(selector, opts = {}) {
  const rect = paletteRect(selector);
  if (!rect) { console.error(`[demo] not found: ${selector}`); return false; }
  const gx = VIEW_X + rect.x + rect.w / 2 + (opts.dx ?? 0);
  const gy = VIEW_Y + rect.y + rect.h / 2 + (opts.dy ?? 0);

  // Move + dwell + ripple in one evalMain round-trip
  evalMain(NAME, `(async () => {
    const d = window.__demo;
    await d.moveTo(${gx}, ${gy}, ${opts.dur ?? 700});
    await d.sleep(${opts.preClickDwell ?? 350});
    d.ripple();
    await d.sleep(60);
    return 'ok';
  })()`);

  // Click in the palette view
  evalPalette(NAME, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'not found';
    el.click();
    return 'ok';
  })()`);
  return true;
}

/** Move cursor into palette area without clicking. */
function moveIntoPalette(xOff, yOff, dur = 700) {
  evalMain(NAME, `(async () => {
    const d = window.__demo;
    await d.moveTo(${VIEW_X + 40 + xOff}, ${VIEW_Y + 40 + yOff}, ${dur});
    await d.sleep(300);
    return 'ok';
  })()`);
}

/** Type character-by-character into the search input. */
function typeInSearch(text, perChar = 80) {
  evalPalette(NAME, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const input = document.getElementById('searchInput');
    input.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const ch of ${JSON.stringify(text)}) {
      set.call(input, (input.value || '') + ch);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await sleep(${perChar});
    }
    return 'ok';
  })()`);
}

function clearSearch() {
  evalPalette(NAME, `(() => {
    const input = document.getElementById('searchInput');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, '');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    return 'ok';
  })()`);
}

/** Type text into the expanded setting row's value input (clears first). */
function typeInSettingInput(key, text, perChar = 100) {
  evalPalette(NAME, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const row = document.querySelector('.set-row[data-key=${JSON.stringify(key)}]');
    if (!row) return 'row not found';
    const input = row.querySelector('.set-row-input');
    if (!input || input.disabled) return 'input not available';
    input.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    // Clear existing value first
    set.call(input, '');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    await sleep(${perChar});
    // Type the new value character by character
    for (const ch of ${JSON.stringify(text)}) {
      set.call(input, (input.value || '') + ch);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await sleep(${perChar});
    }
    return 'ok';
  })()`);
}

/** Uncollapse ancestor groups so the row is visible. */
function ensureGroupVisible(key) {
  evalPalette(NAME, `(() => {
    const row = document.querySelector('.set-row[data-key=${JSON.stringify(key)}]');
    if (!row) return 'row not in DOM';
    let el = row.closest('.set-section');
    while (el) {
      const hdr = el.querySelector(':scope > .set-group-header');
      if (hdr?.classList.contains('collapsed')) hdr.click();
      el = el.parentElement?.closest('.set-section') ?? null;
    }
    return 'ok';
  })()`);
}

function keyInPalette(keystroke) {
  evalPalette(NAME, `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(keystroke)},
      code: ${JSON.stringify(keystroke)},
      bubbles: true, cancelable: true,
    }));
    return 'ok';
  })()`);
}


// ═══════════════════════════════════════════════════════════════════════
//  DEMO
// ═══════════════════════════════════════════════════════════════════════

await sleep(400);

// ── 1. Open settings ─────────────────────────────────────────────────
mark('open settings');
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.moveTo(${VIEW_X + SETTINGS_W / 2 + 40}, ${VIEW_Y + 260}, 800);
  await window.ipc.commandPalette.show({ screen: 'settings' });
  return 'ok';
})()`);
await sleep(300);

// ── 2. Type "theme" in search filter (input auto-focused by settings) ─
mark('filter theme');
typeInSearch('theme', 90);
await sleep(400);

// ── 3. Expand system.theme row ───────────────────────────────────────
mark('expand system.theme');
ensureGroupVisible('system.theme');
clickInSettingsPalette('.set-row[data-key="system.theme"] .set-row-head', { dx: -200, preClickDwell: 400 });
await sleep(300);

// ── 4. Click "Global" scope ──────────────────────────────────────────
mark('scope global');
clickInSettingsPalette('.set-row[data-key="system.theme"] .set-row-scope[data-target="global"]');
await sleep(300);

// ── 5. Type "dark" (input auto-focused by expand) ─────────────────────
mark('type dark');
typeInSettingInput('system.theme', 'dark', 120);
await sleep(400);

// ── 6. Click Save — theme flips to dark ──────────────────────────────
mark('save theme');
clickInSettingsPalette('.set-footer button[data-action="save-all"]', { preClickDwell: 500 });
await sleep(1000);

// ── 7. Move cursor out to reveal dark theme background ───────────────
mark('show dark theme');
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.moveTo(${ws.w - 100}, ${ws.h - 100}, 900);
  await d.sleep(800);
  return 'ok';
})()`);
await sleep(500);

// ── 8. Move cursor back toward palette, clear search ─────────────────
mark('clear search');
moveIntoPalette(380, 180, 800);
await sleep(200);
clearSearch();
await sleep(400);

// ── 9. Collapse all groups ───────────────────────────────────────────
mark('collapse all');
clickInSettingsPalette('.set-toolbar-btn[data-action="collapse-all"]');
await sleep(500);

// ── 10. Expand all groups ────────────────────────────────────────────
mark('expand all');
clickInSettingsPalette('.set-toolbar-btn[data-action="expand-all"]');
await sleep(500);

// ── 11. Keyboard navigation (ArrowDown) ──────────────────────────────
mark('keyboard nav');
for (let i = 0; i < 4; i++) {
  keyInPalette('ArrowDown');
  await sleep(130);
}
await sleep(400);

// ── 12. Expand system.theme again, change scope, type, then Discard ──
mark('edit and discard');
ensureGroupVisible('system.theme');
clickInSettingsPalette('.set-row[data-key="system.theme"] .set-row-head', { dx: -200, preClickDwell: 400 });
await sleep(250);

// Click Global scope
clickInSettingsPalette('.set-row[data-key="system.theme"] .set-row-scope[data-target="global"]');
await sleep(200);

// Type a demo value (input auto-focused by expand)
typeInSettingInput('system.theme', 'light', 100);
await sleep(400);

// Click Discard (reverts unsaved changes)
clickInSettingsPalette('.set-footer button[data-action="discard"]', { preClickDwell: 500 });
await sleep(500);

// ── 13. Filter to "backup" ───────────────────────────────────────────
mark('filter backup');
typeInSearch('backup', 80);
await sleep(400);

// ── 14. Expand backup.interval-hours, Tab-cycle scope ────────────────
mark('expand backup + tab scope');
ensureGroupVisible('system.backup.interval-hours');
clickInSettingsPalette('.set-row[data-key="system.backup.interval-hours"] .set-row-head', { dx: -200, preClickDwell: 400 });
await sleep(300);

// Tab cycles scope: Default → Global → Agent → Default
keyInPalette('Tab');
await sleep(250);
keyInPalette('Tab');
await sleep(250);
keyInPalette('Tab');
await sleep(300);

// ── 15. Escape to collapse, then close palette ──────────────────────
mark('close');
// Escape: collapse expanded row
keyInPalette('Escape');
await sleep(250);

// Two more Escapes: pop settings screen, then close palette
keyInPalette('Escape');
await sleep(200);
keyInPalette('Escape');
await sleep(500);

// ── Final: hide cursor ──────────────────────────────────────────────
mark('done');
evalMain(NAME, `window.ipc.previewCursor.setVisible(false)`);
