# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentWFY is an Electron desktop app with an AI agent that can interact with a local SQLite database and render views in tabs. The agent uses a custom `Agent` class (`src/renderer/src/agent/agent.ts`) for the LLM tool-calling loop and `@mariozechner/pi-ai` for model access and streaming.

## Commands

- `npm run dev` — Start dev mode (Vite dev server + Electron with HMR)
- `npm run build` — Full production build (TypeScript + Vite)
- `npm run build-main` — Compile main process only (TypeScript → dist/)
- `npm run build-renderer` — Build renderer only (Vite → dist/client/)
- `npm run lint` — Run ESLint on all TypeScript files
- `npm start` — Launch Electron from dist/

The main process must be rebuilt (`npm run build-main`) after changes to `src/` files outside `src/renderer/`. The renderer hot-reloads during `npm run dev`.

## Architecture

### Process Model

- **Main process** (`src/main.ts`): Electron window management, IPC handlers, SQLite, custom protocols (`app://`, `agentview://`), file I/O, security enforcement
- **Renderer process** (`src/renderer/`): UI built with vanilla Web Components, agent session management, Vite-bundled
- **Web Workers** (`src/renderer/src/agent/worker/`): Agent sessions run in dedicated workers

### Two TypeScript Configs

- Root `tsconfig.json`: Main process — target ESNext, module CommonJS, `noImplicitAny: true`, compiles `src/**/*` excluding `src/renderer/`
- `src/renderer/tsconfig.json`: Renderer — target ESNext, module ESNext, `strict: false`, path alias `app/*` → `./src/*`

### Vite Configuration (`src/renderer/vite.config.js`)

- `@mariozechner/pi-ai` is aliased to a browser shim at `src/renderer/src/agent/pi_ai_browser.ts`
- `app` resolves to `src/renderer/src/`
- Output goes to `dist/client/`

### IPC Channels

All IPC flows through `src/preload.ts` which exposes two global APIs:
- `window.agentwfy` — Agent tool operations: file ops (read/write/edit/ls/mkdir/remove/find/grep), SQL queries, tab management, event bus, agent spawning
- `window.electronClientTools` — App operations: dialogs, store, sessions, auth, external views

Channel prefixes: `agentwfy:*` (agent tools), `app:*` (app-level), `bus:*` (event bus), `electronExternalView:*` (view management), `dialog:*`, `electron-store:*`

### UI Framework

Custom Web Components (no React/Vue). Components are in `src/renderer/src/components/` with `tl-` prefix:
- `tl-app` — Root shell: activity bar + sidebar + main tab area
- `tl-tabs` — Tab management with external BrowserWindow views
- `tl-agent-chat` — Chat interface for the AI agent
- `tl-activity-bar` — Left sidebar icons

Components use direct DOM manipulation (no virtual DOM), class properties for local state, and CustomEvents for communication.

### Event Bus

`src/renderer/src/event-bus.ts` provides pub/sub with message queuing. `bus-bridge.ts` bridges IPC ↔ EventBus. Key events: `agentwfy:toggle-agent-chat`, `agentwfy:open-view`, `agentwfy:views-db-changed`, `agentwfy:remove-current-tab`, `agentwfy:refresh-view`.

### Agent System

- `AgentWFYAgent` (`src/renderer/src/agent/create_agent.ts`): Wraps pi-agent-core `Agent`, handles session persistence (`.agentwfy/sessions/`), auto-compaction on context overflow, model/thinking-level cycling
- `AgentSessionManager` (`src/renderer/src/agent/session_manager.ts`): Manages concurrent agent sessions
- System prompt is loaded from SQLite `docs` table (rows with `preload = 1`)
- Default provider: `openrouter`, default model: `moonshotai/kimi-k2.5`

### Database

Node.js built-in `sqlite` module (not better-sqlite3). Schema in `src/services/agent-db.ts`:
- `views`: id, name, content, created_at, updated_at
- `docs`: id, name, content, preload, updated_at
- `db_changes`: auto-populated change tracking via triggers

SQL routing (`src/services/sql-router.ts`) supports two targets: `agent` (built-in agent.db) and `sqlite-file` (arbitrary .sqlite files).

### Security

`src/security/path-policy.ts` enforces file access sandboxing. The `.agentwfy/` directory has restricted paths. Agent views run under the `agentview://` protocol with a separate, more restricted preload API.

### Design System

Custom CSS design tokens in `src/renderer/src/global.css`.

## No Test Framework

There is currently no test framework configured in this project.
