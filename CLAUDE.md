# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentWFY is an Electron desktop app that provides a local AI agent runtime. Users create "agents" (directories with a `.agentwfy/agent.db` SQLite database) and interact with LLM-powered agents that can execute JavaScript, manage files, run tasks, and control browser tabs.

## Commands

- **Setup** (first time): `./scripts/setup`
- **Build**: `./scripts/build`
- **Start** (run built app): `./scripts/start`
- **Package**: `./scripts/package`

Build runs tsgo which does full type checking during compilation. A separate lint step is not needed — if the build succeeds, types are correct.

No test framework is configured. See [TESTING.md](TESTING.md) for how to launch the app with CDP, interact with it programmatically, and visually verify changes.

## Architecture

### Process Model

The app runs as three Electron process types:

- **Main process** (`src/main.ts`): Orchestrates the single app window, agent contexts, database, IPC, plugins, triggers
- **Renderer process** (`src/renderer/`): UI built with plain Web Components (no framework), Shadow DOM scoping, custom EventBus pub/sub
- **Utility processes** (`src/runtime/exec_worker.ts`): Per-session JS workers for agent code execution, spawned via `utilityProcess.fork()`

### Build System

tsgo (native TypeScript compiler) compiles all source files to `dist/`, preserving the `src/` directory structure. No bundling — each `.ts` file produces a corresponding `.js` file. Build script at `scripts/build`. System docs, views, and config are compiled from source files into `dist/` during build. Electron and tsgo binaries are downloaded to `vendor/` by `scripts/setup`.

### Key Subsystems

**Agent (`src/agent/`)**: Core `Agent` class streams LLM responses via events (`agent_start`, `stream_update`, `agent_end`). The only tool agents can call is `execJs`. `AgentSessionManager` tracks active sessions in memory and lazy-loads idle sessions from disk (`.agentwfy/sessions/*.json`). Provider state (not display messages) is persisted; display state is rebuilt on restore.

**Providers (`src/providers/`)**: Abstracted via `ProviderFactory`/`ProviderSession` interfaces. The built-in `openai_compatible` provider handles OpenRouter, DeepSeek, Groq, etc. Providers maintain internal message history in OpenAI format, separate from display messages. Context compaction summarizes old messages when approaching token limits. Plugin-registered providers go through the same registry.

**Database (`src/db/`)**: Each agent has its own SQLite database (`.agentwfy/agent.db`). Tables: `docs`, `views`, `tasks`, `triggers`, `config`, `plugins`. Guard triggers on the DB prevent agents from writing to `system.*` and `plugin.*` namespaces. Change tracking via `_changes` temp table enables IPC notifications.

**Global Config (`src/settings/global-config.ts`)**: User-wide settings stored in `~/.agentwfy.json`. Resolution order: Agent DB → `~/.agentwfy.json` → hardcoded defaults. Falls back to the internal Electron store (`userData/config.json`) when the global config file doesn't exist. The internal store (`src/ipc/store.ts`) remains for app-internal state like `installedAgents`.

**Plugins (`src/plugins/`)**: Stored as code strings in the `plugins` table, executed via `new Function()` with full Node.js `require()` access. Each plugin gets a `PluginApi` for registering functions, providers, and pub/sub handlers. Plugin data is namespaced as `plugin.{name}.*` in docs/views/config and auto-cleaned on uninstall.

**Runtime Functions (`src/runtime/`)**: `FunctionRegistry` maps function names to handlers. Built-in functions: `runSql`, file ops (`read`, `write`, `ls`, `find`, `grep`, `mkdir`), tab management, tasks, events, sub-agents, fetch. Plugins can register additional functions.

**IPC (`src/ipc/`)**: Channels defined in `channels.ts`. Each domain (files, sql, tabs, sessions, bus, plugins, providers, agents) has its own handler module. All handlers are async.

**Triggers (`src/triggers/`)**: Three types: `schedule` (cron), `http` (REST endpoints), `event` (pub/sub). The `TriggerEngine` manages lifecycle and auto-reloads on DB changes.

**HTTP API (`src/http-api/`)**: Local HTTP server (default port 9877) for external integrations. Routes are dynamically built from HTTP triggers. Lockfile records the active port.

**Window Manager (`src/window-manager.ts`)**: Single-window architecture — one `BrowserWindow` hosts multiple agent contexts. Shared components (RendererBridge, CommandPalette, ConfirmationManager) are created once. Per-agent components (TabViewManager, TriggerEngine, AgentSessionManager, TaskRunner, JsRuntime, FunctionRegistry, PluginRegistry) are isolated in `AgentContext` objects. Agent switching hides/shows tab views and pushes fresh state to the renderer. `getContextForSender()` returns an `AppWindowContext` Proxy that routes IPC calls to the correct agent — tab view senders map to their owning agent, all other senders map to the active agent.

**Agent Sidebar (`src/renderer/src/components/agent_sidebar.ts`)**: Discord-style sidebar on the far left listing loaded agents. Users click to switch between agents within the single window. The `+` button opens an agent picker dialog. Agent list is managed via `agentSidebar` IPC channels.

### Module Conventions

- ESM throughout (`"type": "module"` in package.json), `.js` extensions in imports
- Preload scripts use `.cts` extension (CommonJS required by Electron)
- Electron nightly (`v41`) is downloaded as a binary to `vendor/electron/` by `scripts/setup`
- TypeScript strict-ish config: `noImplicitAny` enabled, compiled by tsgo (native TypeScript compiler) in `vendor/tsgo/`
