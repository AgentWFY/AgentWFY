#!/usr/bin/env node
// =============================================================================
// cdp.mjs — Zero-dependency CDP client for Electron app interaction
//
// Talks directly to Chrome DevTools Protocol via HTTP + WebSocket.
// No Playwright, no npm dependencies — just Node.js builtins.
//
// Usage:
//   node scripts/cdp.mjs <command> [args...]
//
// Commands:
//   targets                      — List all CDP targets (pages/windows)
//   screenshot [path]            — Screenshot the main app page
//   screenshot-target <id> [path]— Screenshot a specific target
//   eval <js>                    — Evaluate JS in the main page
//   eval-target <id> <js>        — Evaluate JS in a specific target
//   dom                          — Get DOM summary of main page
//   tabs                         — List open tabs via IPC
//   open-tab <url-or-viewId>     — Open a tab via IPC
//   close-tab <tabId>            — Close a tab via IPC
//   console                      — Get console messages from the main page
//   ipc <method> [json-args]     — Call any IPC method
//   test                         — Run connection test
// =============================================================================

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_PORT = process.env.CDP_PORT || '9223';
const CDP_BASE = `http://localhost:${CDP_PORT}`;

// ── CDP Protocol Helpers ────────────────────────────────────────────────────

async function cdpFetch(path) {
  const res = await fetch(`${CDP_BASE}${path}`);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getTargets() {
  return cdpFetch('/json/list');
}

async function getMainTarget() {
  const targets = await getTargets();
  return targets.find(t => t.url.includes('app://')) || targets[0];
}

function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();

    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      close() { ws.close(); },
      ws,
    });

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };

    ws.onerror = (err) => reject(new Error(`WebSocket error: ${err.message || 'connection failed'}`));
    setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdTargets() {
  const targets = await getTargets();
  for (const t of targets) {
    console.log(`[${t.type}] "${t.title}" @ ${t.url}`);
  }
  return targets;
}

async function cmdScreenshot(targetOrPath, path) {
  let target;
  if (targetOrPath && !targetOrPath.includes('/') && !targetOrPath.includes('.')) {
    // It's a target ID
    const targets = await getTargets();
    target = targets.find(t => t.id.startsWith(targetOrPath));
    if (!target) { console.error(`Target not found: ${targetOrPath}`); process.exit(1); }
  } else {
    target = await getMainTarget();
    path = targetOrPath; // first arg was actually the path
  }

  if (!target) { console.error('No target found'); process.exit(1); }

  const outPath = path || '/tmp/agentwfy-screenshot.png';
  const cdp = await connectWebSocket(target.webSocketDebuggerUrl);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outPath, Buffer.from(data, 'base64'));
  console.log(outPath);

  cdp.close();
}

async function cmdEval(targetId, js) {
  let target;
  if (js) {
    const targets = await getTargets();
    target = targets.find(t => t.id.startsWith(targetId));
  } else {
    js = targetId;
    target = await getMainTarget();
  }

  if (!target) { console.error('No target found'); process.exit(1); }

  const cdp = await connectWebSocket(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const result = await cdp.send('Runtime.evaluate', {
    expression: js,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    console.error('Error:', result.exceptionDetails.text);
  } else {
    const val = result.result.value;
    if (val === undefined || val === null) { /* void — no output */ }
    else if (typeof val === 'object') console.log(JSON.stringify(val, null, 2));
    else console.log(val);
  }

  cdp.close();
}

async function cmdDom() {
  const target = await getMainTarget();
  if (!target) { console.error('No target found'); process.exit(1); }

  const cdp = await connectWebSocket(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const result = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const allEls = document.querySelectorAll('*');
      const tagCounts = {};
      let shadowRoots = 0;
      for (const el of allEls) {
        tagCounts[el.tagName.toLowerCase()] = (tagCounts[el.tagName.toLowerCase()] || 0) + 1;
        if (el.shadowRoot) shadowRoots++;
      }
      return { total: allEls.length, shadowRoots, tags: tagCounts };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  const info = result.result.value;
  console.log(`Elements: ${info.total} | Shadow roots: ${info.shadowRoots}`);
  console.log('Tags:', Object.entries(info.tags).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t}(${c})`).join(', '));

  cdp.close();
}

async function cmdTabs() {
  await cmdEval('window.ipc.tabs.getTabState()');
}

async function cmdOpenTab(urlOrViewId) {
  const isNumber = /^\d+$/.test(urlOrViewId);
  const arg = isNumber
    ? `{ viewId: ${urlOrViewId} }`
    : `{ url: ${JSON.stringify(urlOrViewId)} }`;
  await cmdEval(`window.ipc.tabs.openTab(${arg})`);
}

async function cmdCloseTab(tabId) {
  await cmdEval(`window.ipc.tabs.closeTab({ tabId: ${JSON.stringify(tabId)} })`);
}

async function cmdConsole() {
  const target = await getMainTarget();
  if (!target) { console.error('No target found'); process.exit(1); }

  const cdp = await connectWebSocket(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Console.enable');

  console.log('Listening for console messages (Ctrl+C to stop)...\n');

  cdp.ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const type = msg.params.type;
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      console.log(`[${type}] ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log(`[exception] ${msg.params.exceptionDetails.text}`);
    }
  };

  // Keep alive until Ctrl+C
  await new Promise(() => {});
}

async function cmdIpc(method, argsJson) {
  const args = argsJson ? JSON.parse(argsJson) : [];
  const argsStr = Array.isArray(args) ? args.map(a => JSON.stringify(a)).join(', ') : JSON.stringify(args);

  // Parse "domain.method" into window.ipc.domain.method(...)
  const parts = method.split('.');
  let expr;
  if (parts.length === 2) {
    expr = `window.ipc.${parts[0]}.${parts[1]}(${argsStr})`;
  } else {
    expr = `window.ipc.${method}(${argsStr})`;
  }

  await cmdEval(expr);
}

async function cmdLogs() {
  const n = parseInt(args[0] || '50', 10);
  const logPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.log');
  try {
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    const tail = lines.slice(-n).join('\n');
    if (tail.trim()) console.log(tail.trim());
    else console.log('(empty)');
  } catch {
    console.error('No log file found. Is npm run dev running?');
    process.exit(1);
  }
}

async function cmdRestart() {
  // Send restart, expect the connection to drop (that's success)
  try {
    const target = await getMainTarget();
    if (!target) { console.error('No target found'); process.exit(1); }
    const cdp = await connectWebSocket(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    // Fire and don't wait for response — the app exits immediately
    cdp.send('Runtime.evaluate', {
      expression: 'window.ipc.restart()',
      returnByValue: true,
      awaitPromise: true,
    }).catch(() => {});
    // Wait a moment for the process to actually die
    await new Promise(r => setTimeout(r, 500));
  } catch {}
  // Now wait for the new instance
  await cmdWait();
}

async function cmdStop() {
  try {
    const target = await getMainTarget();
    if (!target) { console.error('No target found'); process.exit(1); }
    const cdp = await connectWebSocket(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    cdp.send('Runtime.evaluate', {
      expression: 'window.ipc.stop()',
      returnByValue: true,
      awaitPromise: true,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  } catch {}
  console.log('stopped');
}

async function cmdWait() {
  const timeout = parseInt(args[0] || '30', 10) * 1000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const targets = await cdpFetch('/json/list');
      const main = targets.find(t => t.url.includes('app://'));
      if (main) {
        // Verify WebSocket + IPC work (app fully loaded, not just process started)
        const cdp = await connectWebSocket(main.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        const result = await cdp.send('Runtime.evaluate', {
          expression: 'typeof window.ipc !== "undefined" && typeof window.ipc.getAgentRoot === "function"',
          returnByValue: true,
        });
        cdp.close();
        if (result.result.value === true) {
          console.log('ready');
          return;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  console.error(`Timed out after ${timeout / 1000}s`);
  process.exit(1);
}

async function cmdTest() {
  console.log(`Connecting to CDP on port ${CDP_PORT}...`);

  // 1. List targets
  const targets = await getTargets();
  console.log(`✓ ${targets.length} target(s)`);
  for (const t of targets) console.log(`  [${t.type}] "${t.title}" @ ${t.url}`);

  // 2. Connect to main page
  const main = targets.find(t => t.url.includes('app://'));
  if (!main) { console.error('✗ No main app page'); process.exit(1); }

  const cdp = await connectWebSocket(main.webSocketDebuggerUrl);
  console.log(`✓ WebSocket connected`);

  // 3. Screenshot
  await cdp.send('Runtime.enable');
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/agentwfy-test.png', Buffer.from(data, 'base64'));
  console.log(`✓ Screenshot saved to /tmp/agentwfy-test.png`);

  // 4. Evaluate JS
  const evalResult = await cdp.send('Runtime.evaluate', {
    expression: '({ title: document.title, elements: document.querySelectorAll("*").length })',
    returnByValue: true,
  });
  const info = evalResult.result.value;
  console.log(`✓ Eval works: "${info.title}", ${info.elements} elements`);

  // 5. IPC test
  const ipcResult = await cdp.send('Runtime.evaluate', {
    expression: 'window.ipc.getAgentRoot()',
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(`✓ IPC works: agentRoot=${ipcResult.result.value}`);

  cdp.close();
  console.log('\nAll checks passed.');
}

// ── Main ────────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

const commands = {
  targets: () => cmdTargets(),
  screenshot: () => cmdScreenshot(args[0], args[1]),
  'screenshot-target': () => cmdScreenshot(args[0], args[1]),
  eval: () => cmdEval(args[0], args[1]),
  'eval-target': () => cmdEval(args[0], args[1]),
  dom: () => cmdDom(),
  tabs: () => cmdTabs(),
  'open-tab': () => cmdOpenTab(args[0]),
  'close-tab': () => cmdCloseTab(args[0]),
  console: () => cmdConsole(),
  ipc: () => cmdIpc(args[0], args[1]),
  logs: () => cmdLogs(),
  restart: () => cmdRestart(),
  stop: () => cmdStop(),
  wait: () => cmdWait(),
  test: () => cmdTest(),
};

if (!cmd || !commands[cmd]) {
  console.log('Usage: node scripts/cdp.mjs <command> [args...]');
  console.log('');
  console.log('Commands:');
  console.log('  targets                       List all CDP targets');
  console.log('  screenshot [path]             Screenshot main page');
  console.log('  screenshot-target <id> [path] Screenshot specific target');
  console.log('  eval <js>                     Evaluate JS in main page');
  console.log('  eval-target <id> <js>         Evaluate JS in specific target');
  console.log('  dom                           DOM summary');
  console.log('  tabs                          List open tabs');
  console.log('  open-tab <url-or-viewId>      Open a tab');
  console.log('  close-tab <tabId>             Close a tab');
  console.log('  console                       Stream console messages');
  console.log('  ipc <method> [json-args]      Call IPC method');
  console.log('  logs [lines]                  Show Electron main process logs (default: 50)');
  console.log('  restart                       Restart app and wait until ready');
  console.log('  stop                          Stop app and dev.sh');
  console.log('  wait [timeout-secs]           Wait until app is ready (default: 30s)');
  console.log('  test                          Run connection test');
  process.exit(1);
}

commands[cmd]().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
