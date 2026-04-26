#!/usr/bin/env node
// Install the anthropic-provider plugin from the public registry.
//
//   1. Open `system.plugins` as a tab.
//   2. Switch to the "Browse Plugins" sub-tab.
//   3. Click Install on the anthropic-provider row.
//   4. Confirm in the install dialog.
//   5. Switch back to "Installed Plugins" once the install lands.
//
// Recorded with `--no-test-provider` so the Installed Plugins list
// starts empty — the only plugin shown at the end is the one we just
// installed.

import {
  clickInPalette, clickInTab, confirmDialog, evalMain, evalPalette,
  hoverInTab, installCursorHelpers, mark, sleep, typeInPalette, waitInTab,
} from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

await installCursorHelpers(NAME);
mark('helpers installed');

// 1. Open the command palette, type "plugin", click the Plugins & Agents
// view in the results.
await sleep(400);
evalMain(NAME, `window.ipc.commandPalette.show()`);
await sleep(700);

await typeInPalette(NAME, 'plugin', 100);
await sleep(500);

// The default-selected item is "Install Plugin" (an action), so we
// can't just press Enter — we resolve the data-index of the
// "Plugins & Agents" view item and click that specifically.
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

// 2. Pause briefly on the Installed Plugins list so the starting state
// is on screen before we switch.
await hoverInTab(NAME, 'system.plugins', '.tab-btn[data-tab="installed"]');
await sleep(700);

// 3. Click "Browse Plugins" sub-tab.
await clickInTab(NAME, 'system.plugins', '.tab-btn[data-tab="browse-plugins"]');
await sleep(800);
mark('switched to browse');

// 4. Wait for the registry response to render the anthropic row.
const found = await waitInTab(NAME, 'system.plugins',
  `() => !!document.querySelector('.btn-install[data-name="anthropic-provider"]')`,
  { timeoutMs: 15000 });
if (!found) throw new Error('anthropic-provider row never appeared');
mark('registry loaded');

// 5. Hover the row, then move to Install and click.
await hoverInTab(NAME, 'system.plugins',
  '.plugin-row:has(.btn-install[data-name="anthropic-provider"])',
  { dx: 200, dur: 800 });
await sleep(700);

await clickInTab(NAME, 'system.plugins',
  '.btn-install[data-name="anthropic-provider"]');
mark('install clicked');

// 6. Confirm in the plugin-install dialog.
await confirmDialog(NAME, 'confirm');
mark('install confirmed');

// 7. Wait until the row's Install button flips to "Update" — that's the
// signal the install completed and the plugins list reloaded.
await waitInTab(NAME, 'system.plugins', `() => {
  const btn = document.querySelector('.btn-install[data-name="anthropic-provider"]');
  return btn && !btn.disabled && btn.textContent.trim() === 'Update';
}`, { timeoutMs: 30000 });
await sleep(500);
mark('install landed');

// 8. Switch back to Installed Plugins to show the new entry.
await clickInTab(NAME, 'system.plugins', '.tab-btn[data-tab="installed"]');
await sleep(700);

// 9. Drift over the new anthropic row to call attention to it.
await hoverInTab(NAME, 'system.plugins',
  '.plugin-row:has([data-name="anthropic-provider"])',
  { dx: 220, dur: 800 });
await sleep(1500);
mark('done');

evalMain(NAME, `window.ipc.previewCursor.setVisible(false)`);
