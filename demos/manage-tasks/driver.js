#!/usr/bin/env node
// Demo for the redesigned Task Panel:
//   - Tasks tab shows full descriptions (no 2-line clamp)
//   - Each task and each trigger has a trash-icon delete affordance
//   - Two-click confirm: first click swaps the icon for a red Confirm
//     pill; second click deletes. Pending state auto-clears after 3s.
//
// Flow:
//   1. Seed 4 tasks + 4 triggers (one with a long description).
//   2. Switch to the Tasks panel, Tasks sub-tab.
//   3. Hover the trash icon on "Cleanup Old Logs" → it brightens on hover.
//   4. Click → red Confirm pill appears in place of the icon.
//   5. Click again → task and its cron trigger are removed.
//   6. Switch to the Triggers sub-tab.
//   7. Hover + two-click delete on the HTTP "Quick Health Check" trigger
//      (its task remains).
//
// Invoked by scripts/record-demo with $PREVIEW_NAME set.

import { evalMain, installCursorHelpers, sleep } from '../../scripts/lib/demo.mjs';

const NAME = process.env.PREVIEW_NAME;
if (!NAME) { console.error('PREVIEW_NAME not set'); process.exit(1); }

await installCursorHelpers(NAME);

// === 1. Seed tasks + triggers, then open the Tasks panel =================
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const ipc = window.ipc;

  // Clean any prior state from re-runs.
  await ipc.sql.run({ target: 'agent', sql: 'DELETE FROM triggers' });
  await ipc.sql.run({ target: 'agent', sql: 'DELETE FROM tasks' });

  const tasks = [
    ['cleanup', 'Cleanup Old Logs',
      'Removes log files older than 30 days from the local logs directory.'],
    ['daily-standup', 'Daily Standup Reminder',
      'Sends a daily reminder to the team channel about the morning standup. Pulls the agenda from the shared docs and posts it 5 minutes before the meeting starts.'],
    ['quick', 'Quick Health Check',
      'Pings each registered service and reports any non-200 status codes.'],
    ['digest', 'Weekly Digest',
      'Compiles the most important emails and notion updates of the week into a single summary. Filters out automated noise, dedupes threads, and ranks by stakeholder importance using a small heuristic.'],
  ];
  for (const [name, title, description] of tasks) {
    await ipc.sql.run({
      target: 'agent',
      sql: 'INSERT INTO tasks (name, title, description, content) VALUES (?, ?, ?, ?)',
      params: [name, title, description, 'console.log("noop")'],
    });
  }

  const triggers = [
    ['standup-cron', 'daily-standup', 'schedule', '{"expression":"55 8 * * 1-5"}', 'Weekday mornings at 08:55', 1],
    ['digest-cron',  'digest',        'schedule', '{"expression":"0 17 * * 5"}',   'Friday afternoons at 17:00',  1],
    ['cleanup-cron', 'cleanup',       'schedule', '{"expression":"0 3 * * *"}',    'Daily 03:00',                 0],
    ['health-http',  'quick',         'http',     '{"method":"POST","path":"/api/health-check"}', 'Manual health probe', 1],
  ];
  for (const [name, task_name, type, config, description, enabled] of triggers) {
    await ipc.sql.run({
      target: 'agent',
      sql: 'INSERT INTO triggers (name, task_name, type, config, description, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      params: [name, task_name, type, config, description, enabled],
    });
  }

  await d.sleep(300);

  // Switch from Chat to the Tasks panel.
  await d.clickSelector('.awfy-app-sidebar-switcher-btn[data-panel="tasks"]', null, null, 700);
  await d.sleep(800);

  // Click the "Tasks" sub-tab inside the shadow root.
  const panel = document.querySelector('awfy-task-panel');
  const tasksTab = panel.shadowRoot.querySelector('.tab[data-tab="tasks"]');
  const tr = tasksTab.getBoundingClientRect();
  await d.moveTo(tr.left + tr.width / 2, tr.top + tr.height / 2, 600);
  tasksTab.click();
  await d.sleep(900);
  return 'seeded';
})()`);

// === 2. Hover + two-click delete on a task ===============================
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const panel = document.querySelector('awfy-task-panel');
  const trash = panel.shadowRoot.querySelector('[data-delete-task="cleanup"]');
  const r = trash.getBoundingClientRect();

  // Hover so the icon brightens (compact UX: ~55% opacity → 100% on hover).
  await d.moveTo(r.left + r.width / 2, r.top + r.height / 2, 800);
  await d.sleep(900);

  // First click → the icon swaps for a red "Confirm" pill.
  trash.click();
  await window.ipc.previewCursor.flash();
  await d.sleep(1300);

  // Re-query — the rerender replaced the node, and the pill is wider.
  const confirmPill = panel.shadowRoot.querySelector('[data-delete-task="cleanup"]');
  const cr = confirmPill.getBoundingClientRect();
  await d.moveTo(cr.left + cr.width / 2, cr.top + cr.height / 2, 500);
  await d.sleep(400);

  // Second click → task is deleted, cron trigger cascades.
  confirmPill.click();
  await window.ipc.previewCursor.flash();
  await d.sleep(1100);
  return 'task-deleted';
})()`);

// === 3. Switch to the Triggers sub-tab ===================================
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const panel = document.querySelector('awfy-task-panel');
  const trigTab = panel.shadowRoot.querySelector('.tab[data-tab="triggers"]');
  const r = trigTab.getBoundingClientRect();
  await d.moveTo(r.left + r.width / 2, r.top + r.height / 2, 600);
  trigTab.click();
  await d.sleep(900);
  return 'on-triggers';
})()`);

// === 4. Two-click delete on a trigger (task untouched) ==================
evalMain(NAME, `(async () => {
  const d = window.__demo;
  const panel = document.querySelector('awfy-task-panel');
  const trash = panel.shadowRoot.querySelector('[data-delete-trigger="health-http"]');
  const r = trash.getBoundingClientRect();

  await d.moveTo(r.left + r.width / 2, r.top + r.height / 2, 700);
  await d.sleep(800);

  trash.click();
  await window.ipc.previewCursor.flash();
  await d.sleep(1200);

  const confirmPill = panel.shadowRoot.querySelector('[data-delete-trigger="health-http"]');
  const cr = confirmPill.getBoundingClientRect();
  await d.moveTo(cr.left + cr.width / 2, cr.top + cr.height / 2, 500);
  await d.sleep(400);

  confirmPill.click();
  await window.ipc.previewCursor.flash();
  await d.sleep(1100);

  await window.ipc.previewCursor.setVisible(false);
  return 'done';
})()`);
