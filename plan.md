# Task Triggers Implementation Plan

## Overview

Add a trigger system that can run tasks on a schedule, on HTTP requests, or on event bus events. Rewrite the HTTP server to be purely trigger-based (no more generic RPC). AI manages triggers via SQL.

Tasks are trigger-agnostic — they don't know if they were started by a trigger, command palette, or agent. Multiple triggers can point to the same task.

## Database Schema

Add `triggers` table to `src/db/sqlite.ts`:

```sql
CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('schedule', 'http', 'event')),
  config TEXT NOT NULL,        -- JSON
  description TEXT DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

Config examples by type:

### schedule config

Uses a 6-field expression with seconds: `"second minute hour day month weekday"`

| User says | AI writes | Meaning |
|---|---|---|
| "every 30 seconds" | `{ "expression": "*/30 * * * * *" }` | Every 30s |
| "every day at 3am" | `{ "expression": "0 0 3 * * *" }` | Daily 3:00:00 AM |
| "every Monday at 9am" | `{ "expression": "0 0 9 * * 1" }` | Monday 9:00 AM |
| "on the 1st and 15th" | `{ "expression": "0 0 0 1,15 * *" }` | Midnight on 1st & 15th |
| "weekdays every hour" | `{ "expression": "0 0 * * * 1-5" }` | Hourly Mon-Fri |
| "every even day at noon" | `{ "expression": "0 0 12 2-30/2 * *" }` | Noon on 2nd,4th,6th... |

Field order: `second(0-59) minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-6, 0=Sun)`

Supports: `*`, ranges (`1-5`), lists (`1,15`), steps (`*/30`, `2-30/2`).

The engine parses this itself — no external library needed. It uses `setTimeout` to schedule the next matching tick, recalculating after each run.

### http config

```json
{ "path": "/telegram", "method": "POST", "auth": "none" }
```

- `path` — route path mounted on the HTTP server (required)
- `method` — HTTP method, defaults to `"POST"` (optional)
- `auth` — `"token"` (default, requires Bearer token) or `"none"` (public, no auth)

### event config

```json
{ "topic": "agentwfy:views-db-changed" }
```

## Task Input — Trigger-Agnostic

`startTask` gains an optional `input` parameter: `startTask(taskId, input?)`

The task runner passes `input` to the worker as a global variable. Task code accesses it as `input` — it's just data, could be anything or `undefined`.

| Trigger type | What `input` contains |
|---|---|
| schedule | `undefined` |
| http | `{ method, path, headers, query, body }` |
| event | The event data (whatever was published) |
| command palette | `undefined` |
| agent | `undefined` (or custom data if agent passes it) |

The task code is identical regardless of how it's started. A task that handles Telegram webhooks just reads `input.body` — it doesn't know or care that an HTTP trigger started it.

## Files to Create/Modify

### 1. `src/db/sqlite.ts` — Add table + change tracking triggers
- Add `triggers` CREATE TABLE to `AGENT_DB_SCHEMA_SQL`
- Add insert/update/delete temp triggers for `triggers` table to `CHANGE_TRACKING_SQL`

### 2. `src/triggers/scheduler.ts` — **NEW** — Schedule expression parser
- `parseExpression(expr: string)` → parsed 6-field structure
- `nextMatch(parsed, after: Date)` → next Date that matches
- Supports: `*`, values, ranges, lists, steps — no external deps

### 3. `src/triggers/engine.ts` — **NEW** — Trigger engine (main process)
Core class `TriggerEngine`:
- Loads all enabled triggers from DB on start
- Reloads when `triggers` table changes
- Three trigger types:
  - **schedule**: `setTimeout` to next matching tick via scheduler.ts. On fire: `startTask(taskId)`, recompute next, schedule again.
  - **http**: Registers route on HTTP server. On request: `startTask(taskId, { method, path, headers, query, body })` → gets runId → waits for `task:run:{runId}` on event bus → returns task result as HTTP response.
  - **event**: Subscribes to bus topic. On event: `startTask(taskId, eventData)`.
- `start()` / `stop()` / `reload()` lifecycle
- Each active trigger tracked by ID with cleanup function

### 4. `src/http-api/server.ts` — Rewrite to trigger-only server
- Remove `POST /rpc` and all RPC method handling
- Remove `createMethodRegistry` dependency
- Keep `GET /files/*` for file serving
- Add dynamic route registration:
  - `registerRoute(path, method, handler, opts: { auth })` / `unregisterRoute(path, method)`
  - Routes stored in a Map, matched on incoming requests
- Auth is per-route: check Bearer token only when `auth !== 'none'`
- CORS stays

### 5. `src/http-api/handlers.ts` — Gut to utilities only
- Delete `createMethodRegistry` and all RPC handlers
- Keep only `mimeFromExt`

### 6. `src/renderer/src/tasks/task_runner.ts` — Add input support
- `runTask(taskId, input?)` — accepts optional input
- Passes `input` to the worker (e.g. as a global or message before exec)

### 7. `src/task-runner/ipc.ts` — Pass input through forwarding
- `startTask` IPC now carries optional `input` parameter
- Forward it through to the renderer's TaskRunner

### 8. `src/main.ts` — Wire trigger engine
- Import and instantiate `TriggerEngine`
- Pass it `startTask`, `busWaitFor`, `getAgentRoot`, HTTP route registration
- Start engine after HTTP server is created
- On `onDbChange`: if table is `triggers`, call `engine.reload()`
- Stop engine on `before-quit`
- On agent root change, stop and restart engine

## HTTP Request → Task Flow

```
Telegram POST /telegram (auth: none)
  → HTTP server matches route, skips auth
  → Reads body
  → Calls route handler in TriggerEngine
  → startTask(taskId, { method: "POST", path: "/telegram", headers, query, body })
  → Gets runId
  → Waits for task:run:{runId} on event bus (existing mechanism)
  → Task runs, finishes, result published to bus
  → Engine gets result → sends HTTP response
  → { ok: true, data: task.result } or { ok: false, error: task.error }
```

## Schedule Trigger Flow

```
Engine loads trigger: expression "0 0 3 * * *"
  → Parse → compute next match from now → setTimeout
  → On fire: startTask(taskId) with no input
  → Recompute next match, setTimeout again
```

## Event Trigger Flow

```
Engine subscribes to bus topic
  → Event fires with data
  → startTask(taskId, eventData)
  → Task runs with input = eventData
```

## Implementation Order

1. Schema change (`src/db/sqlite.ts`)
2. Task runner input support (`task_runner.ts`, `task-runner/ipc.ts`)
3. Schedule expression parser (`src/triggers/scheduler.ts`)
4. Rewrite HTTP server (`src/http-api/server.ts`)
5. Clean up handlers (`src/http-api/handlers.ts`)
6. Create trigger engine (`src/triggers/engine.ts`)
7. Wire in main process (`src/main.ts`)
