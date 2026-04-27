#!/usr/bin/env node
// Anthropic-provider end-to-end demo:
//
//   1. Flip global theme to dark via the palette → Settings screen.
//   2. Install the anthropic-provider plugin (mirrors install-plugin).
//   3. Push the local agent's plugin.anthropic-provider.* config rows
//      into the preview agent.db so the new provider is authenticated.
//   4. Switch to Installed Plugins, return to chat, select Anthropic.
//   5. Send "create a view which will show dashboard with statistic for
//      AgentWFY repo since version 1.3.0" and wait for the run to finish.
//   6. Open the Function trace panel and animate-scroll to the bottom.
//
// Driver-time timestamps are written to marks.json so the post-process
// script can speed up just the long "session running" segment.

import {
  clickInPalette, clickInTab, confirmDialog, evalMain, evalPalette,
  hoverInTab, installCursorHelpers, mark, sleep, typeInPalette, waitInTab,
} from '../../scripts/lib/demo.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

const __dirname = dirname(fileURLToPath(import.meta.url));

await installCursorHelpers(NAME);
mark('helpers installed');

const t0 = Date.now();
const stamps = {};
const stamp = (key) => { stamps[key] = (Date.now() - t0) / 1000; mark(key); };

// --- 1. Dark theme -----------------------------------------------------
await sleep(400);
evalMain(NAME, `window.ipc.commandPalette.show({ screen: 'settings' })`);
await sleep(800);

evalPalette(NAME, `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const type = async (el, text, per = 100) => {
    el.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const ch of text) {
      set.call(el, (el.value || '') + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await sleep(per);
    }
  };
  await type(document.getElementById('searchInput'), 'theme');
  await sleep(400);
  const card = document.querySelector('.settings-card[data-setting-key="system.theme"]');
  card.scrollIntoView({ block: 'center' });
  await sleep(200);
  card.querySelector('.settings-target-btn[data-target="global"]').click();
  await sleep(250);
  await type(card.querySelector('input.settings-card-input'), 'dark', 110);
  await sleep(400);
  [...document.querySelectorAll('button.btn')].find(b => b.textContent.trim() === 'Save').click();
  await sleep(500);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  await sleep(150);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  return 'ok';
})()`);
await sleep(900);
mark('dark theme set');

// --- 2. Open Plugins & Agents view via palette -------------------------
evalMain(NAME, `window.ipc.commandPalette.show()`);
await sleep(700);
await typeInPalette(NAME, 'plugin', 100);
await sleep(500);

const pluginsIdx = evalPalette(NAME, `(() => {
  const el = [...document.querySelectorAll('.item')].find(it =>
    it.querySelector('.item-title')?.textContent === 'Plugins & Agents');
  return el ? el.dataset.index : null;
})()`);
if (pluginsIdx == null) throw new Error('Plugins & Agents not in palette results');
await clickInPalette(NAME, `.item[data-index="${pluginsIdx}"]`);
await waitInTab(NAME, 'system.plugins',
  `() => !!document.querySelector('.tab-btn[data-tab="installed"]')`,
  { timeoutMs: 5000 });
mark('plugins tab open');

// --- 3. Browse → Install anthropic-provider ----------------------------
await hoverInTab(NAME, 'system.plugins', '.tab-btn[data-tab="installed"]');
await sleep(500);
await clickInTab(NAME, 'system.plugins', '.tab-btn[data-tab="browse-plugins"]');
await sleep(700);

const found = await waitInTab(NAME, 'system.plugins',
  `() => !!document.querySelector('.btn-install[data-name="anthropic-provider"]')`,
  { timeoutMs: 15000 });
if (!found) throw new Error('anthropic-provider row never appeared');
mark('registry loaded');

await hoverInTab(NAME, 'system.plugins',
  '.plugin-row:has(.btn-install[data-name="anthropic-provider"])',
  { dx: 200, dur: 800 });
await sleep(600);
await clickInTab(NAME, 'system.plugins',
  '.btn-install[data-name="anthropic-provider"]');
mark('install clicked');
await confirmDialog(NAME, 'confirm');
mark('install confirmed');

await waitInTab(NAME, 'system.plugins', `() => {
  const btn = document.querySelector('.btn-install[data-name="anthropic-provider"]');
  return btn && !btn.disabled && btn.textContent.trim() === 'Update';
}`, { timeoutMs: 30000 });
await sleep(500);
mark('install landed');

// --- 4. Push provider settings from local agent.db --------------------
const KEYS = [
  'plugin.anthropic-provider.effort',
  'plugin.anthropic-provider.hide-intermediate-steps',
  'plugin.anthropic-provider.hide-thinking',
  'plugin.anthropic-provider.max-tokens',
  'plugin.anthropic-provider.model-id',
  'plugin.anthropic-provider.oauth-access',
  'plugin.anthropic-provider.oauth-expires',
  'plugin.anthropic-provider.oauth-refresh',
];
const localDb = `${process.env.HOME}/projects/agentwfy/.agentwfy/agent.db`;
const SEP = String.fromCharCode(31); // unit separator — won't collide with secret values
const out = spawnSync('sqlite3', [
  '-separator', SEP,
  localDb,
  `SELECT name, value FROM config WHERE name IN (${KEYS.map(k => `'${k}'`).join(',')});`,
], { encoding: 'utf8' });
if (out.status !== 0) throw new Error('reading local agent.db failed: ' + out.stderr);
const rows = out.stdout.trim().split('\n').filter(Boolean).map(l => l.split(SEP));
if (rows.length === 0) throw new Error('no plugin.anthropic-provider config rows in local agent.db');
const escSql = (s) => s.replace(/'/g, "''");
// UPDATE-only: install just created the plugin's config rows with empty
// values, so they exist; INSERT would trip the system/plugin guard.
const upserts = rows.map(([n, v]) =>
  `UPDATE config SET value='${escSql(v ?? '')}' WHERE name='${escSql(n)}';`
).join('\n');
const sqlRes = spawnSync('./scripts/preview',
  ['--sqlite', NAME, upserts],
  { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
if (sqlRes.status !== 0) throw new Error('preview --sqlite upsert failed');
mark('provider settings pushed');

// --- 5. Back to Installed Plugins, then to chat ------------------------
await clickInTab(NAME, 'system.plugins', '.tab-btn[data-tab="installed"]');
await sleep(600);
await hoverInTab(NAME, 'system.plugins',
  '.plugin-row:has([data-name="anthropic-provider"])',
  { dx: 220, dur: 600 });
await sleep(700);
mark('installed tab shown');

// --- 6. Select Anthropic provider, send the dashboard request ----------
evalMain(NAME, `(async () => {
  const d = window.__demo;

  const card = await d.waitFor('.provider-card[data-provider-id="anthropic"]', 10000);
  if (!card) throw new Error('Anthropic provider card not visible');
  await d.moveToEl(card, 180, 40, 900);
  await d.clickEl(card);
  await d.sleep(500);

  const ta = await d.waitFor('textarea#msg-input', 5000);
  await d.moveToEl(ta, 100, 22, 700);
  await d.clickEl(ta);
  await d.typeInto(ta,
    'create a view which will show dashboard with statistic for AgentWFY repo since version 1.3.0',
    32);
  await d.sleep(400);
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  }));
  return 'ok';
})()`);
stamp('msg_sent');

// --- 7. Wait for the run to finish (composer-stop hidden) --------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  await d.waitFor(
    () => !document.querySelector('.composer-stop:not([style*="display: none"])'),
    900000
  );
  return 'ok';
})()`);
stamp('msg_done');

// Show the result for a few seconds at normal speed before opening traces.
await sleep(4000);

// --- 8. Open Function trace panel and scroll to bottom -----------------
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const btn = await d.waitFor('button.icon-btn[title="Function trace"]', 8000);
  if (!btn) throw new Error('trace button never appeared');
  await d.moveToEl(btn, null, null, 700);
  await d.clickEl(btn);

  await d.waitFor(() =>
    document.querySelector('[data-list-body] .tr-list') ||
    document.querySelector('[data-list-body] .tr-empty'), 10000);
  await d.sleep(500);

  const body = document.querySelector('[data-list-body]');
  if (body && body.scrollHeight > body.clientHeight) {
    const target = body.scrollHeight;
    const start = body.scrollTop;
    const dur = 1800;
    const tStart = performance.now();
    const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    while (true) {
      const t = Math.min(1, (performance.now() - tStart) / dur);
      body.scrollTop = start + (target - start) * ease(t);
      if (t >= 1) break;
      await new Promise(r => setTimeout(r, 16));
    }
  }
  await d.sleep(2500);
  return 'ok';
})()`);
mark('trace shown');

stamps.t_total = (Date.now() - t0) / 1000;
writeFileSync(join(__dirname, 'marks.json'), JSON.stringify(stamps, null, 2));

evalMain(NAME, `window.ipc.previewCursor.setVisible(false)`);
