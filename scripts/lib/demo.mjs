// Helpers shared by demo drivers (demos/<name>/driver.js).
//
// A driver is a Node script that orchestrates a demo by shelling out to
// ./scripts/preview. It runs in the worktree root with PREVIEW_NAME set
// by scripts/record-demo.
//
// Each evalMain / evalPalette call is a fresh CDP connection. The app
// page itself persists between calls, so anything set on `window`
// (including window.__demo — installed by installCursorHelpers below)
// remains available for subsequent calls. Cursor coordinates are
// tracked in window.__demo so a second eval can continue motion from
// where the first left off without restating the position.

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
    state.ripple = (x, y) => {
      const r = document.createElement('div');
      r.style.cssText = \`position:fixed;left:\${x}px;top:\${y}px;pointer-events:none;z-index:2147483646;border:2px solid #4a9dff;border-radius:50%;transform:translate(-50%,-50%);width:6px;height:6px;opacity:.85;transition:width .45s ease-out,height .45s ease-out,opacity .45s ease-out;\`;
      document.body.appendChild(r);
      requestAnimationFrame(() => { r.style.width = '52px'; r.style.height = '52px'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    };
    const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: state.x, clientY: state.y, button: 0,
      buttons: type === 'mousedown' ? 1 : 0, view: window,
    }));
    state.clickEl = async (el) => {
      state.ripple(state.x, state.y);
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
