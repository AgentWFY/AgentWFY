import { runAgentDbSql } from './db/sqlite.js';
import { SHORTCUT_PREFIX } from './system-config/keys.js';

const DEFAULT_HOME_VIEW = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Home</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: auto; }
  body {
    font-family: var(--font-family);
    background: var(--color-bg1);
    color: var(--color-text3);
    display: flex;
    justify-content: center;
    padding: 80px 32px 60px;
  }
  .container {
    max-width: 520px;
    width: 100%;
  }

  /* Hero */
  .hero {
    text-align: center;
    margin-bottom: 40px;
  }
  .hero h1 {
    font-size: 26px;
    font-weight: 600;
    color: var(--color-text4);
    margin-bottom: 8px;
  }
  .hero p {
    font-size: 14px;
    color: var(--color-text1);
    line-height: 1.6;
    margin-bottom: 20px;
  }
  .hero-shortcuts {
    display: flex;
    justify-content: center;
    gap: 8px;
  }
  .hero-shortcut {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: var(--color-bg2);
    border: 1px solid var(--color-border1);
    border-radius: 8px;
    font-size: 13px;
    color: var(--color-text2);
  }
  .hero-shortcut kbd {
    padding: 2px 8px;
    font-size: 12px;
    font-family: var(--font-family);
    background: var(--color-bg3);
    border: 1px solid var(--color-border1);
    border-radius: 4px;
    color: var(--color-text3);
  }

  /* Cards */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 24px;
  }
  .card {
    background: var(--color-bg2);
    border: 1px solid var(--color-border1);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .card .label {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text3);
    margin-bottom: 4px;
  }
  .card .desc {
    font-size: 12px;
    color: var(--color-text1);
    line-height: 1.5;
  }

  /* Links */
  .nav {
    text-align: center;
    padding-top: 8px;
    font-size: 12px;
    color: var(--color-text1);
  }
  .nav a {
    color: var(--color-text2);
    text-decoration: none;
    cursor: pointer;
  }
  .nav a:hover {
    color: var(--color-text4);
  }
  a.view-link {
    color: var(--color-text3);
    text-decoration: underline;
    text-decoration-color: var(--color-border1);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  a.view-link:hover {
    color: var(--color-text4);
    text-decoration-color: var(--color-text2);
  }
</style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <h1>Welcome to AgentWFY</h1>
      <p>Open the chat to start building. Ask the agent to create views, automate tasks, or manage your data.</p>
      <div class="hero-shortcuts">
        <div class="hero-shortcut">Agent Chat <kbd class="mod-shortcut">I</kbd></div>
        <div class="hero-shortcut">Command Palette <kbd class="mod-shortcut">K</kbd></div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="label">Agent</div>
        <div class="desc">A workspace tied to a directory. Distributed as <code>.agent.awfy</code> files. <a class="view-link" data-view="system.plugins">Discover &rarr;</a></div>
      </div>
      <div class="card">
        <div class="label">Views</div>
        <div class="desc">Interactive interfaces in tabs — dashboards, forms, tools. Built by the agent for your workflow.</div>
      </div>
      <div class="card">
        <div class="label">Tasks & Triggers</div>
        <div class="desc">JavaScript that runs in a sandbox. Trigger on a schedule, HTTP request, or event.</div>
      </div>
      <div class="card">
        <div class="label">Docs</div>
        <div class="desc">Shape the agent's behavior. Root-level docs are preloaded into the system prompt.</div>
      </div>
    </div>

    <div class="nav">
      <a class="view-link" data-view="system.docs">Docs</a> &middot;
      <a class="view-link" data-view="system.plugins">Plugins & Agents</a> &middot;
      <a class="view-link" data-view="system.source-explorer">Source Explorer</a>
    </div>
  </div>

  <script>
    const mod = navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl';
    function formatShortcutLabel(raw, defaultKey) {
      const str = raw || defaultKey;
      if (str === 'disabled') return null;
      const parts = str.split('+');
      const key = parts.pop().toUpperCase();
      const mods = parts.map(m => m === 'mod' ? mod : m.charAt(0).toUpperCase() + m.slice(1));
      return [...mods, key].join('+');
    }
    (async () => {
      const shortcuts = { 'toggle-agent-chat': 'mod+i', 'toggle-command-palette': 'mod+k' };
      const names = Object.keys(shortcuts).map(id => '${SHORTCUT_PREFIX}' + id);
      let configMap = {};
      try {
        const rows = await window.agentwfy.runSql({
          target: 'agent',
          sql: "SELECT name, value FROM config WHERE name IN (" + names.map(() => '?').join(',') + ")",
          params: names
        });
        for (const r of rows) configMap[r.name] = r.value;
      } catch {}
      const labels = Object.entries(shortcuts).map(([id, def]) =>
        formatShortcutLabel(configMap['${SHORTCUT_PREFIX}' + id], def)
      );
      const els = document.querySelectorAll('kbd.mod-shortcut');
      labels.forEach((label, i) => {
        if (els[i] && label) els[i].textContent = label;
        else if (els[i]) els[i].parentElement.style.display = 'none';
      });
    })();

    document.addEventListener('click', async (e) => {
      const link = e.target.closest('[data-view]');
      if (!link) return;
      e.preventDefault();
      const viewName = link.dataset.view;
      const rows = await window.agentwfy.runSql({
        target: 'agent',
        sql: 'SELECT name, title FROM views WHERE name = ? LIMIT 1',
        params: [viewName],
      });
      if (rows.length > 0) {
        await window.agentwfy.openTab({ viewName: rows[0].name, title: rows[0].title || viewName });
      }
    });
  </script>
</body>
</html>`;

/**
 * Seed a freshly created agent database with default content (Home view).
 * Uses INSERT OR IGNORE so it's safe to call on an existing agent.
 */
export async function seedDefaultAgent(agentRoot: string): Promise<void> {
  await runAgentDbSql(agentRoot, {
    sql: `INSERT OR IGNORE INTO views (name, title, content) VALUES (?, ?, ?)`,
    params: ['home', 'Home', DEFAULT_HOME_VIEW],
  });
}
