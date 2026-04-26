// Helpers shared by demo drivers (demos/<name>/driver.js).
//
// A driver is a Node script that orchestrates a demo by shelling out to
// ./scripts/preview. It runs in the worktree root with PREVIEW_NAME set
// by scripts/record-demo.
//
// Each evalMain / evalTab / evalPalette call is a fresh CDP connection.
// The app page itself persists between calls, so anything set on
// `window` (including window.__demo, installed by installCursorHelpers
// below) remains available for subsequent calls. Cursor coordinates are
// tracked in window.__demo so a second eval can continue motion from
// where the first left off without restating the position.
//
// Performance rule: every `runEval` (and its `evalMain` / `evalTab` /
// `evalPalette` / `evalConfirm` wrappers) spawns `./scripts/preview`,
// which docker-execs into the container — ~300–600 ms per call. For any
// "wait until X happens" loop, do NOT poll from the host; pass an async
// loop into a single eval with `waitInTab` (or its inline equivalent)
// so the waiting happens inside the renderer at ~150 ms granularity.

import { spawnSync } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a CDP eval in a specific preview target.
function runEval(name, targetFrag, js) {
  const args = ['./scripts/preview', '--eval', name];
  if (targetFrag) args.push('--tab', targetFrag);
  args.push(js);
  const res = spawnSync(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
  if (res.status !== 0) {
    throw new Error(`preview --eval failed (status ${res.status})`);
  }
  const out = res.stdout.toString().trimEnd();
  if (!out) return null;
  try { return JSON.parse(out); } catch { return out; }
}

export const evalMain = (name, js) => runEval(name, null, js);
export const evalPalette = (name, js) => runEval(name, 'command_palette.html', js);
export const evalConfirm = (name, js) => runEval(name, 'confirmation.html', js);
export const evalTab = (name, frag, js) => runEval(name, frag, js);

// --- Tab-content interaction --------------------------------------------
//
// Tabs are WebContentsViews stacked above the main renderer. To drive
// their DOM you have to (a) query the element rect in tab-local coords
// via `--eval --tab <frag>`, (b) translate to global coords using the
// tab's main-process bounds (from window.ipc.tabs.describe()) so the
// cursor overlay lines up, then (c) dispatch the click inside the tab.

// tabBounds memoizes per (name, frag) — driver-level demos hit the same
// tab repeatedly and the bounds are stable unless layout changes. Call
// `clearTabBoundsCache()` after a sidebar collapse / zen toggle / etc.
const _tabBoundsCache = new Map();
const _tabBoundsKey = (name, frag) => `${name}::${frag}`;
export async function tabBounds(name, frag) {
  const key = _tabBoundsKey(name, frag);
  if (_tabBoundsCache.has(key)) return _tabBoundsCache.get(key);
  const bounds = await runEval(name, null, `(async () => {
    const desc = await window.ipc.tabs.describe();
    const t = desc.tabs.find(t => t.viewName === ${JSON.stringify(frag)} && t.isSelected)
            || desc.tabs.find(t => t.viewName === ${JSON.stringify(frag)});
    return t ? t.bounds : null;
  })()`);
  if (bounds) _tabBoundsCache.set(key, bounds);
  return bounds;
}
export function clearTabBoundsCache() { _tabBoundsCache.clear(); }

export function rectInTab(name, frag, selector) {
  return runEval(name, frag, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
}

// Poll inside a view (any --tab frag) until `selector` resolves. Used
// by clickInPalette and confirmDialog to wait out the open animation.
function _waitRectInView(name, frag, selector) {
  return runEval(name, frag, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
      await sleep(150);
    }
    return null;
  })()`);
}

// Several handlers (provider card, tool header, popup close) listen on
// mousedown only, so dispatch the full sequence rather than .click().
function _dispatchFullClick(name, frag, selector) {
  return runEval(name, frag, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
    return 'ok';
  })()`);
}

// Move the cursor over an element inside a tab. Options:
//   dx, dy — local offsets within the element rect (default: center)
//   dur    — cursor animation duration in ms (default: 700)
export async function hoverInTab(name, frag, selector, opts = {}) {
  const bounds = await tabBounds(name, frag);
  if (!bounds) throw new Error(`Tab not found: ${frag}`);
  const rect = rectInTab(name, frag, selector);
  if (!rect) throw new Error(`Element not found in ${frag}: ${selector}`);
  const dx = opts.dx ?? rect.w / 2;
  const dy = opts.dy ?? rect.h / 2;
  const gx = bounds.x + rect.x + dx;
  const gy = bounds.y + rect.y + dy;
  await runEval(name, null, `window.__demo.moveTo(${gx}, ${gy}, ${opts.dur ?? 700})`);
}

export async function clickInTab(name, frag, selector, opts = {}) {
  await hoverInTab(name, frag, selector, opts);
  await sleep(opts.preClickDelay ?? 200);
  await runEval(name, null, `window.ipc.previewCursor.flash()`);
  await _dispatchFullClick(name, frag, selector);
  await sleep(opts.postClickDelay ?? 0);
}

// `predicate` is the source of an arrow-function expression that runs
// in the tab; return any truthy value to stop, or null/false to keep
// polling. Returns whatever the predicate returned, or null on timeout.
//
//   const installed = await waitInTab(NAME, 'system.plugins',
//     `() => { const b = document.querySelector('.btn-install[data-name="x"]');
//              return b && b.textContent.trim() === 'Update'; }`);
export async function waitInTab(name, frag, predicate, { timeoutMs = 30000, intervalMs = 150 } = {}) {
  return runEval(name, frag, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const start = Date.now();
    const fn = (${predicate});
    while (Date.now() - start < ${timeoutMs}) {
      const result = fn();
      if (result) return result;
      await sleep(${intervalMs});
    }
    return null;
  })()`);
}

// --- Confirmation dialog ------------------------------------------------
//
// Any IPC that flows through the confirmation manager (currently:
// requestInstallPlugin / requestTogglePlugin / requestUninstallPlugin /
// requestInstallAgent — see src/confirmation/) opens a separate
// WebContentsView at file:///app/dist/confirmation.html. The view's
// bounds aren't exposed to the renderer, so we mirror the formula from
// src/confirmation/manager.ts.
export async function confirmDialog(name, action = 'confirm', opts = {}) {
  const buttonId = action === 'cancel' ? '#cancelBtn' : '#confirmBtn';
  const rect = await _waitRectInView(name, 'confirmation.html', buttonId);
  if (!rect) throw new Error(`Confirmation dialog not visible (looking for ${buttonId})`);
  const ws = await runEval(name, null, `({ w: window.innerWidth, h: window.innerHeight })`);
  // Mirrors src/confirmation/manager.ts: 420×300 dialog centered
  // horizontally, top at max(40, ch * 0.25); WebContentsView is offset
  // by 40 px on every side for the drop shadow. rect.x/y are relative
  // to the view's document (which already includes the 40 px CSS
  // padding), so adding viewX/viewY gives a global cursor coord.
  const viewX = Math.floor((ws.w - 420) / 2) - 40;
  const viewY = Math.max(40, Math.floor(ws.h * 0.25)) - 40;
  const gx = viewX + rect.x + rect.w / 2;
  const gy = viewY + rect.y + rect.h / 2;
  await runEval(name, null, `window.__demo.moveTo(${gx}, ${gy}, ${opts.dur ?? 700})`);
  await sleep(opts.preClickDelay ?? 500);
  await runEval(name, null, `window.ipc.previewCursor.flash()`);
  await runEval(name, 'confirmation.html', `document.querySelector(${JSON.stringify(buttonId)}).click()`);
}

// --- Command palette ----------------------------------------------------
//
// The palette is its own WebContentsView (`command_palette.html`) with
// the same drop-shadow padding pattern as the confirm dialog.

export function typeInPalette(name, text, perChar = 80) {
  return runEval(name, 'command_palette.html', `(async () => {
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

// Mirrors src/command-palette/manager.ts:
//   width = clamp(cw*0.42, 420, 560); x = (cw-width)/2;
//   y = max(40, ch*0.15); WebContentsView padded 40 px each side.
export async function clickInPalette(name, selector, opts = {}) {
  const rect = await _waitRectInView(name, 'command_palette.html', selector);
  if (!rect) throw new Error(`Palette element not visible: ${selector}`);
  const ws = await runEval(name, null, `({ w: window.innerWidth, h: window.innerHeight })`);
  const width = Math.min(560, Math.max(420, Math.floor(ws.w * 0.42)));
  const viewX = Math.floor((ws.w - width) / 2) - 40;
  const viewY = Math.max(40, Math.floor(ws.h * 0.15)) - 40;
  const gx = viewX + rect.x + rect.w / 2;
  const gy = viewY + rect.y + rect.h / 2;
  await runEval(name, null, `window.__demo.moveTo(${gx}, ${gy}, ${opts.dur ?? 700})`);
  await sleep(opts.preClickDelay ?? 400);
  await runEval(name, null, `window.ipc.previewCursor.flash()`);
  await _dispatchFullClick(name, 'command_palette.html', selector);
  await sleep(opts.postClickDelay ?? 0);
}

// --- Per-step timing ----------------------------------------------------
//
// `mark(label)` prints elapsed-since-last-mark on stderr (so it stays
// out of the JSON stdout that runEval parses). Drivers sprinkle marks
// to make slow steps visible without instrumenting individual calls.
let _markPrev = Date.now();
let _markStart = _markPrev;
export function mark(label) {
  const now = Date.now();
  const dt = ((now - _markPrev) / 1000).toFixed(2);
  const total = ((now - _markStart) / 1000).toFixed(2);
  process.stderr.write(`[step] +${dt}s  (total ${total}s)  ${label}\n`);
  _markPrev = now;
}

// Install the cursor / DOM helpers as window.__demo so subsequent
// evalMain calls can just call them. Each demo calls this once at the
// top of the driver.
export async function installCursorHelpers(name) {
  evalMain(name, `(async () => {
    const cursor = window.ipc.previewCursor;
    window.__demo ??= { x: 1180, y: 640 };
    const state = window.__demo;
    await cursor.setPos(state.x, state.y);
    await cursor.setVisible(true);

    state.sleep = ms => new Promise(r => setTimeout(r, ms));
    const sleep = state.sleep;

    const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    state.moveTo = async (x, y, dur = 700) => {
      const fx = state.x, fy = state.y, dx = x - fx, dy = y - fy, start = Date.now();
      while (true) {
        const t = Math.min(1, (Date.now() - start) / dur), p = ease(t);
        state.x = fx + dx * p; state.y = fy + dy * p;
        await cursor.setPos(state.x, state.y);
        if (t >= 1) break;
        await sleep(16);
      }
    };
    // Ripple lives in the cursor overlay's own view (src/preview-cursor/manager.ts)
    // so it renders above tab WebContentsViews — a renderer-DOM ripple
    // would be occluded.
    state.ripple = () => { void cursor.flash(); };
    const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: state.x, clientY: state.y, button: 0,
      buttons: type === 'mousedown' ? 1 : 0, view: window,
    }));
    state.clickEl = async (el) => {
      state.ripple();
      await sleep(60);
      if (el) { fire(el, 'mousedown'); fire(el, 'mouseup'); fire(el, 'click'); }
      await sleep(220);
    };
    state.moveToEl = async (el, xo, yo, dur) => {
      const r = el.getBoundingClientRect();
      await state.moveTo(r.left + (xo ?? r.width / 2), r.top + (yo ?? r.height / 2), dur);
    };
    state.clickSelector = async (sel, xo, yo, dur) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      await state.moveToEl(el, xo, yo, dur);
      await state.clickEl(el);
      return true;
    };
    state.typeInto = async (el, text, perChar = 70) => {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
      for (const ch of text) {
        set.call(el, (el.value || '') + ch);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        await sleep(perChar);
      }
    };
    state.waitFor = async (sel, timeout = 10000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const el = typeof sel === 'function' ? sel() : document.querySelector(sel);
        if (el) return el;
        await sleep(120);
      }
      return null;
    };
    return 'ok';
  })()`);
}
