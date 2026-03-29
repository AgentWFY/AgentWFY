<p align="center">
  <img src="icons/icon.png" width="128" height="128" alt="AgentWFY">
</p>

<h1 align="center">AgentWFY</h1>

<p align="center"><strong>A local runtime for AI agents.</strong></p>

<p align="center">
  <a href="https://github.com/AgentWFY/AgentWFY/releases/latest"><img src="https://img.shields.io/github/v/release/AgentWFY/AgentWFY" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20|%20Windows%20|%20Linux-lightgrey" alt="Platform: macOS | Windows | Linux">
  <a href="https://github.com/AgentWFY/AgentWFY/stargazers"><img src="https://img.shields.io/github/stars/AgentWFY/AgentWFY" alt="Stars"></a>
</p>

<br>

<p align="center">
  <video src="https://github.com/user-attachments/assets/62bec9d2-058e-45d1-83ec-3e2d0db24db9" width="720"></video>
</p>

<br>

## What is AgentWFY?

AgentWFY is an open-source desktop app that gives AI agents a real runtime on your machine. Not another chatbot wrapper — each agent gets its own **SQLite database**, **file system**, **JavaScript execution**, **browser control**, and **automation triggers**.

Tell an agent what you need in plain English. It writes code, builds databases, creates live dashboards, sets up cron jobs, and exposes HTTP endpoints — all running locally on your machine.

Each agent is a portable directory. Copy it to another machine, open it, everything works.

## Features

<table>
<tr>
<td width="50%">

**Code Execution**<br>
<sub>Agents run JavaScript in sandboxed Node.js workers. One powerful tool — <code>execJs</code> — for everything.</sub>

</td>
<td width="50%">

**SQLite Per Agent**<br>
<sub>Every agent has its own embedded database. Docs, views, tasks, triggers, config, plugins — all in one portable file.</sub>

</td>
</tr>
<tr>
<td>

**Browser Control**<br>
<sub>Open tabs, capture screenshots, execute DOM JavaScript. Scrape websites, monitor changes, automate the web.</sub>

</td>
<td>

**Triggers & Automation**<br>
<sub>Cron schedules (down to seconds), HTTP webhooks, file watchers, event bus. Agents run unattended.</sub>

</td>
</tr>
<tr>
<td>

**HTML Views**<br>
<sub>Agents build live dashboards, forms, charts, and custom interfaces — stored in the database, rendered as tabs.</sub>

</td>
<td>

**Plugin System**<br>
<sub>Extend with plugins that have full Node.js access. Custom functions, LLM providers, views, and config.</sub>

</td>
</tr>
<tr>
<td>

**Multi-Provider**<br>
<sub>OpenRouter, Ollama, DeepSeek, Groq, LM Studio — any OpenAI-compatible API. Fully offline with local models.</sub>

</td>
<td>

**Sub-Agents**<br>
<sub>Spawn child agents for parallel workflows. Coordinate via pub/sub event bus.</sub>

</td>
</tr>
<tr>
<td>

**HTTP API**<br>
<sub>Local REST server for external integrations. Trigger agents from curl, Home Assistant, n8n, or any script.</sub>

</td>
<td>

**Private by Default**<br>
<sub>Your data stays on your machine. No telemetry, no cloud dependency, no accounts.</sub>

</td>
</tr>
</table>

## Quick Start

### Install

Download the latest release for your platform from [**GitHub Releases**](https://github.com/AgentWFY/AgentWFY/releases/latest):

| Platform | Download |
|----------|----------|
| **macOS** | `.dmg` (Apple Silicon) |
| **Windows** | `.exe` installer |
| **Linux** | `.deb` package |

### Your First Agent

1. Open AgentWFY
2. Pick or create a directory — this becomes your agent's workspace
3. Configure a provider (OpenRouter, Ollama, DeepSeek, etc.)
4. Start talking

### Try These Prompts

```
Create a personal finance tracker. Log expenses with amount, category, and date.
Show a summary dashboard with spending by category as a bar chart.
```

```
Every 30 minutes, fetch the current Bitcoin price and log it.
Create a dashboard with a line chart showing the price history.
```

```
Open https://news.ycombinator.com in a tab. Extract the top 10 stories
and create a clean reading-list view.
```

```
Watch my "incoming" folder for new CSV files. When one appears,
import it into a SQLite table and create a searchable data explorer view.
```

```
Create an HTTP endpoint at /api/notes that accepts POST with JSON
and saves to a notes table. Support GET to retrieve all.
```

## How It Works

```
        You
         │
         ▼
   ┌───────────┐      ┌────────────┐
   │  Chat UI  │      │  Triggers  │
   └─────┬─────┘      │  cron      │
         │            │  http      │
         ▼            │  events    │
   ┌───────────┐      └─────┬──────┘
   │    LLM    │            │
   └─────┬─────┘            │
         │                  │
         ▼                  ▼
   ┌────────────────────────────┐
   │          execJs            │
   │   one tool, full runtime   │
   ├────────────────────────────┤
   │ SQLite  Files    Browser   │
   │ Events  HTTP API  Plugins  │
   └─────────────┬──────────────┘
                 │
                 ▼
       ┌─────────────────┐
       │  Views  (tabs)  │
       │  dashboards     │
       │  forms · charts │
       └─────────────────┘

   Everything in one portable directory:
   my-agent/.agentwfy/agent.db
```

Agents have exactly **one tool**: `execJs`. Every action — reading files, querying databases, opening browser tabs, spawning sub-agents — is JavaScript code executed in a sandboxed worker. Instead of 20 separate tool schemas, the agent composes operations naturally in code.

Two entry points into the runtime: **you** (via chat) and **triggers** (cron, HTTP webhooks, file watchers, events). Both execute the same JavaScript with the same capabilities.

## Use Cases

| Use Case | What the Agent Does |
|----------|-------------------|
| **Personal Dashboard** | Builds a live dashboard from CSV/JSON/API data with Chart.js charts |
| **Web Monitoring** | Opens sites on a schedule, captures screenshots, detects changes with AI vision |
| **File Processing Pipeline** | Watches a folder, processes new files automatically, stores results in SQLite |
| **Personal CRM** | Tracks contacts, follow-up reminders via cron, daily briefing reports |
| **Local API Server** | Exposes HTTP endpoints backed by SQLite — a webhook receiver, mock API, or microservice |
| **Research Assistant** | Spawns sub-agents to explore topics in parallel, builds a knowledge graph view |
| **Development Tools** | Code review dashboards, log analyzers, project scaffolders with full file access |
| **Multi-Agent Workflows** | Chains tasks via event bus — document processing, ETL pipelines, report generation |

## Providers

The built-in provider works with any OpenAI-compatible API:

| Provider | Type | Setup |
|----------|------|-------|
| [**OpenRouter**](https://openrouter.ai) | Cloud | API key + default base URL |
| [**DeepSeek**](https://platform.deepseek.com) | Cloud | API key + DeepSeek base URL |
| [**Groq**](https://groq.com) | Cloud | API key + Groq base URL |
| [**Ollama**](https://ollama.ai) | Local | No API key, `http://localhost:11434/v1` |
| [**LM Studio**](https://lmstudio.ai) | Local | No API key, `http://localhost:1234/v1` |
| Any OpenAI-compatible | Either | API key + base URL |
| [**Anthropic Claude**](https://github.com/AgentWFY/agentwfy-anthropic-provider) | Cloud | Provider plugin — works with Anthropic subscription |

Need a different API format? [Write a provider plugin.](docs/DOCUMENTATION.md#custom-llm-providers-via-plugins)

## Plugin Ecosystem

Plugins extend AgentWFY with custom functions, LLM providers, views, and configuration. They run with full Node.js access in the main process.

Install plugins from the built-in registry (command palette → Plugins → Browse), or build your own:

```
my-plugin/
├── package.json       # metadata
├── build.mjs          # builds .plugins.awfy package
├── src/index.js       # exports activate(api)
├── docs/              # markdown docs
├── views/             # HTML views
└── config/            # default settings
```

See the [Plugin Development Guide](docs/DOCUMENTATION.md#plugin-system) for the full API.

## Build from Source

```bash
git clone https://github.com/AgentWFY/AgentWFY.git
cd AgentWFY
./scripts/setup    # downloads Electron + tsgo to vendor/
./scripts/build    # compiles TypeScript
./scripts/start    # launches the app
```

## Documentation

Full technical documentation — runtime functions, database schema, views system, triggers, HTTP API, plugin development, provider sessions, and configuration reference:

**[docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)**

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create a feature branch
3. Build (`./scripts/build`) — includes full type checking
4. Test — see [TESTING.md](TESTING.md) for details
5. Open a Pull Request

## License

[MIT](LICENSE)
