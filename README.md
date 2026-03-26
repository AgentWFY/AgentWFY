# AgentWFY

The desktop platform for personal AI agents.

Build, install, and run AI agents that work with your data. Each agent is a single portable file — sandboxed, extensible with plugins, and entirely yours.

https://agentwfy.com/demo.mp4

## Features

- **Views** — Agents build dashboards, tables, charts, and custom interfaces rendered as live tabs
- **Plugins & agents** — Browse the community registry or build and publish your own
- **One file, portable** — Each agent is a single file — share it, back it up, everything is inside
- **Sandboxed** — Each agent only accesses its own folder
- **Automation** — Schedule tasks with cron, trigger via HTTP, or react to events
- **Any AI model** — OpenAI-compatible APIs work out of the box, plugins add the rest
- **Private by default** — Your data stays on your machine

## Getting Started

```bash
git clone https://github.com/agentWFY/agentWFY.git
cd agentWFY
npm install
npm run build
npm start
```

For development with hot reload:

```bash
npm run dev
```

## Tech Stack

- Electron
- TypeScript
- esbuild
- SQLite
- Web Components

## License

MIT
