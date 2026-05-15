#!/usr/bin/env node
// Remote-agent demo.
//
// The driver provisions an agentwfy-remote-server inside the running preview
// container, installs plugins/test-provider into that remote agent, adds it
// through the Add Remote Agent palette screen, then sends real chat messages
// through the remote daemon.

import { spawnSync } from 'node:child_process'
import { evalMain, evalPalette, evalTab, installCursorHelpers, mark, sleep } from '../../scripts/lib/demo.mjs'

const NAME = process.env.PREVIEW_NAME
if (!NAME) {
  console.error('PREVIEW_NAME not set')
  process.exit(1)
}

const REMOTE_LABEL = 'remote-demo'
const REMOTE_ROOT = '/tmp/agentwfy-remote-demo'
const REMOTE_LOG = '/tmp/agentwfy-remote-demo.log'
const REMOTE_PORT = 9878
const REMOTE_URL = `http://127.0.0.1:${REMOTE_PORT}`
const SERVER = '/app/remote-backend-server/dist/remote-backend-server/src/index.js'
const INSTALLER = '/app/remote-backend-server/dist/shared/plugins/installer.js'
const TEST_PROVIDER_PACKAGE = '/app/plugins/test-provider/dist/test-provider.plugins.awfy'

function preview(args, opts = {}) {
  const res = spawnSync('./scripts/preview', args, {
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
  if (res.status !== 0) {
    const stderr = res.stderr?.toString().trim()
    const stdout = res.stdout?.toString().trim()
    throw new Error(`preview ${args.join(' ')} failed${stderr ? `\n${stderr}` : ''}${stdout ? `\n${stdout}` : ''}`)
  }
  return res.stdout?.toString() ?? ''
}

function previewExec(args, opts) {
  return preview(['--exec', NAME, ...args], opts)
}

async function setupRemoteDaemon() {
  mark('prepare remote daemon')
  previewExec(['bash', '-lc', [
    `pkill -f '[r]emote-backend-server/dist/remote-backend-server/src/index.js' || true`,
    `rm -rf '${REMOTE_ROOT}' '${REMOTE_LOG}'`,
  ].join('\n')])

  previewExec(['npm', '--prefix', '/app/plugins/test-provider', 'run', 'build'])

  const initOut = previewExec(['node', SERVER, 'init', REMOTE_ROOT])
  const token = initOut.match(/Bearer token:\s*([^\s]+)/)?.[1]
  if (!token) throw new Error(`Could not parse remote token:\n${initOut}`)

  const installCode = [
    `import { installFromPackage } from ${JSON.stringify(INSTALLER)};`,
    `console.log(JSON.stringify(installFromPackage(${JSON.stringify(REMOTE_ROOT)}, ${JSON.stringify(TEST_PROVIDER_PACKAGE)})));`,
  ].join('\n')
  previewExec(['node', '--input-type=module', '-e', installCode])

  previewExec(['bash', '-lc', [
    `AGENTWFY_AGENT_ROOT='${REMOTE_ROOT}' \\`,
    `AGENTWFY_REMOTE_HOST=127.0.0.1 \\`,
    `AGENTWFY_REMOTE_PORT=${REMOTE_PORT} \\`,
    `node '${SERVER}' start >'${REMOTE_LOG}' 2>&1 &`,
  ].join('\n')])

  previewExec(['bash', '-lc', [
    `for i in $(seq 1 40); do`,
    `  code=$(curl -s -o /tmp/remote-demo-probe.out -w '%{http_code}' '${REMOTE_URL}/api/v1/ws' || true)`,
    `  [ "$code" = "426" ] && exit 0`,
    `  sleep 0.25`,
    `done`,
    `cat '${REMOTE_LOG}' >&2 || true`,
    `exit 1`,
  ].join('\n')])

  return token
}

async function removePriorRemoteAgent() {
  evalMain(NAME, `(async () => {
    const agents = await window.ipc.agentSidebar.getInstalled();
    if (!agents.some(a => a.path === ${JSON.stringify(REMOTE_LABEL)})) return 'none';
    const local = agents.find(a => a.backend === 'local');
    if (local) await window.ipc.agentSidebar.switch(local.path);
    await window.ipc.agentSidebar.remove(${JSON.stringify(REMOTE_LABEL)}).catch(() => {});
    return 'removed';
  })()`)
}

async function addRemoteAgent(token) {
  mark('add remote agent')
  evalMain(NAME, `window.ipc.commandPalette.show({ screen: 'add-remote-agent' })`)
  await sleep(800)

  evalPalette(NAME, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const fill = (field, value) => {
      const el = document.querySelector('input[data-field="' + field + '"]');
      if (!el) throw new Error('missing field: ' + field);
      setter.call(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    };
    for (let i = 0; i < 40 && !document.querySelector('input[data-field="slug"]'); i++) await sleep(100);
    fill('slug', ${JSON.stringify(REMOTE_LABEL)});
    fill('baseUrl', ${JSON.stringify(REMOTE_URL)});
    fill('token', ${JSON.stringify(token)});
    document.querySelector('[data-action="test"]').click();
    for (let i = 0; i < 40; i++) {
      const status = document.querySelector('.edit-error, .edit-description');
      const text = status?.textContent || '';
      if (text.includes('Connected')) return text;
      if (text.includes('failed')) throw new Error(text);
      await sleep(250);
    }
    throw new Error('Test connection timed out');
  })()`)

  evalPalette(NAME, `document.querySelector('[data-action="save"]').click()`)

  evalMain(NAME, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 60; i++) {
      const agents = await window.ipc.agentSidebar.getInstalled();
      const remote = agents.find(a => a.path === ${JSON.stringify(REMOTE_LABEL)});
      if (remote?.active && remote.remoteStatus === 'connected') return remote;
      await sleep(250);
    }
    throw new Error('remote agent did not become active and connected');
  })()`)
}

async function selectTestProvider() {
  mark('select remote test provider')
  evalMain(NAME, `(async () => {
    await window.ipc.providers.setDefault('test-provider');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
      const card = document.querySelector('.provider-card[data-provider-id="test-provider"]');
      if (card) {
        card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      }
      await sleep(100);
      if (card?.classList.contains('selected')) return 'ok';
    }
    throw new Error('test-provider card did not become selected');
  })()`)
}

async function installChatHelpers() {
  evalMain(NAME, `(async () => {
    const d = window.__demo;
    d.send = async (cmd, perChar = 45) => {
      const ta = await d.waitFor('textarea#msg-input', 3000);
      await d.moveToEl(ta, 120, 22, 500);
      await d.clickEl(ta);
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '');
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      await d.typeInto(ta, cmd, perChar);
      await d.sleep(250);
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    };
    d.notStreaming = () => !document.querySelector('.composer-stop:not([style*="display: none"])');
    d.assistantHas = (text) => Array.from(document.querySelectorAll('.assistant-text')).some(el => el.textContent.includes(text));
    return 'ok';
  })()`)
}

async function sendRemoteMessages() {
  mark('remote normal response')
  evalMain(NAME, `(async () => {
    const d = window.__demo;
    await d.send('normal');
    await d.waitFor(() => d.notStreaming() && d.assistantHas('normal response from the test provider'), 20000);
    await d.sleep(900);
    return 'ok';
  })()`)

  mark('remote streaming response')
  evalMain(NAME, `(async () => {
    const d = window.__demo;
    await d.send('slow');
    await d.waitFor(() => d.assistantHas('One. Two. Three.'), 8000);
    await d.sleep(2200);
    await d.waitFor(() => d.notStreaming() && d.assistantHas('One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.'), 15000);
    await d.sleep(800);
    return 'ok';
  })()`)

  mark('remote exec_js tool')
  evalMain(NAME, `(async () => {
    const d = window.__demo;
    await d.send('tools');
    await d.waitFor(() => d.notStreaming() && d.assistantHas('Tool execution through the async iterator interface works'), 20000);
    await d.sleep(1200);
    return 'ok';
  })()`)
}

async function createAndOpenRemoteView() {
  mark('remote db view sync')
  evalMain(NAME, `(async () => {
    const d = window.__demo;
    await d.send('remote-view');
    await d.waitFor(() => d.assistantHas('remote view is now open from the desktop mirror'), 25000);
    for (let i = 0; i < 40; i++) {
      const desc = await window.ipc.tabs.describe();
      if (desc.tabs.some(t => t.viewName === 'remote-sync-demo')) {
        await d.sleep(1200);
        return 'ok';
      }
      await d.sleep(250);
    }
    throw new Error('remote-sync-demo tab did not open');
  })()`)

  const heading = evalTab(NAME, 'remote-sync-demo', `document.querySelector('h1')?.textContent || ''`)
  if (!String(heading).includes('Remote DB Sync Works')) {
    throw new Error(`Remote sync demo view did not render locally; heading=${JSON.stringify(heading)}`)
  }
}

await installCursorHelpers(NAME)
const token = await setupRemoteDaemon()
await removePriorRemoteAgent()
await addRemoteAgent(token)
await selectTestProvider()
await installChatHelpers()
await sendRemoteMessages()
await createAndOpenRemoteView()

evalMain(NAME, `(async () => {
  await window.__demo.moveTo(1180, 640, 700);
  await window.ipc.previewCursor.setVisible(false);
  return 'ok';
})()`)
