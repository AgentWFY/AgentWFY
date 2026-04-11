# <img src="icons/icon.png" width="32" height="32" alt="">&nbsp;&nbsp;AgentWFY

A desktop app for running AI agents locally. Each agent is a single SQLite file with its own JavaScript runtime, browser, HTTP server, and scheduler — scoped to a directory you pick.

<p align="center">
  <video src="https://github.com/user-attachments/assets/62bec9d2-058e-45d1-83ec-3e2d0db24db9" width="720"></video>
</p>

## Why AgentWFY?

LLMs are good at writing small, personal tools. But the harnesses around them are all terminal-first. Great for code, useless the moment you want something you can click on. So you end up building your own. Then you spend the next week babysitting git, because one bad run and it's gone.

AgentWFY handles that part. You get a window, HTML views pinned as tabs, scheduled jobs, a local HTTP server, and everything an agent writes lives in one SQLite file you can copy, back up, or throw away.

It's built for two things:

- **Looking at your data.** Point it at a folder, CSV, or API and ask for a dashboard. You get an HTML **view** pinned as a tab.
- **Running things on a schedule.** Cron jobs, webhooks, file watchers. **Tasks** do the work; **triggers** decide when.

The safety story is boring on purpose. One SQLite file, auto-backed-up, with access only to the directory you picked. If a run goes sideways, roll the file back.

When the built-in functions can't do what you need, install a **plugin**.

## Compared to Skills and MCP

Skills and MCP sit at opposite ends of the same problem: how does a model use tools?

- **MCP** hands over a fixed list of tools with a strict schema. Predictable, but you have to write a server for everything.
- **Skills** hand over a markdown file and leave interpretation open. Flexible, but there's no runtime — whatever tools exist are whatever the harness already exposes.

AgentWFY sits in between. There's one tool, `execJs`, that runs JavaScript. The available functions are documented in plain markdown, read the way you'd read docs yourself: only root documents are loaded into the system prompt, and agents can follow links when they need more information.

## Features

- **execJs** — one tool. Every action is JavaScript running in a sandboxed Node worker.
- **SQLite per agent** — docs, views, tasks, triggers, config, and plugins all live in one file.
- **Views** — HTML dashboards, forms, and charts, stored in the database and rendered as tabs.
- **Triggers** — cron (down to seconds), HTTP webhooks, file watchers, event bus.
- **Browser control** — open tabs, screenshot, run JavaScript in the page.
- **Sub-agents** — spawn children for parallel work, coordinate over pub/sub.
- **HTTP API** — local REST server to hook up curl, Home Assistant, n8n, and the rest.
- **Plugins** — a Node.js escape hatch for custom functions, providers, views, and config.
- **Providers** — OpenAI-compatible APIs out of the box: OpenRouter, DeepSeek, Groq, Ollama, LM Studio. Anything else via plugin. Runs offline with local models.

## Quick start

1. Download the latest release for [macOS, Windows, or Linux](https://github.com/AgentWFY/AgentWFY/releases/latest).
2. Configure a provider (OpenRouter, Ollama, DeepSeek, etc.).
3. Start chatting.

## Build from source

```bash
git clone https://github.com/AgentWFY/AgentWFY.git
cd AgentWFY
./scripts/setup    # downloads Electron + tsgo to vendor/
./scripts/build
./scripts/start
```

## Documentation

Full technical reference — runtime functions, database schema, views, triggers, HTTP API, plugin development, and configuration — lives in **[docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)**.

## License

[MIT](LICENSE)
