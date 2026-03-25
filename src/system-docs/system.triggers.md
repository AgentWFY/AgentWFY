# system.triggers

Triggers automate task execution. Stored in the `triggers` table.

## Schema

```sql
triggers (id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, type TEXT CHECK(type IN ('schedule','http','event')), config TEXT, description TEXT DEFAULT '', enabled INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER)
```

- `task_id` — references the task to run. Cascades on delete.
- `type` — one of: `schedule`, `http`, `event`
- `config` — JSON string, format depends on type
- `enabled` — 1 (active) or 0 (disabled)

Triggers reload automatically when the table changes.

## input

All trigger types support an optional `input` field in their config. When set, it overrides the trigger's default input and is passed to the task as its `input` global. Without it, each trigger passes its natural default (schedule: none, http: request data, event: event data).

## schedule

Cron-like scheduling with 6-field expressions.

Config: `{ "expression": "second minute hour day month weekday", "input": ... }`

Fields (left to right):
1. seconds (0-59)
2. minutes (0-59)
3. hours (0-23)
4. day of month (1-31)
5. month (1-12)
6. weekday (0-6, 0=Sunday)

Syntax: `*` (any), single values (`5`), ranges (`1-5`), lists (`1,15`), steps (`*/10`, `2-30/2`).

Examples:
- `0 */5 * * * *` — every 5 minutes
- `0 0 9 * * 1-5` — 9:00 AM weekdays
- `*/30 * * * * *` — every 30 seconds

## http

Exposes an HTTP endpoint that triggers the task when called.

Config: `{ "path": "/my-endpoint", "method": "POST", "input": ... }`

- `path` — URL path for the endpoint (must start with `/`)
- `method` — GET, POST, PUT, PATCH, DELETE (default: POST)
Task receives as input: `{ method, path, headers, query, body }` (overridden by `input` when configured)

## event

Subscribes to an internal event bus topic.

Config: `{ "topic": "my-topic", "input": ... }`

Task receives the published event data as input. Fires each time a message is published to the topic (overridden by `input` when configured).

### File watcher events

Event triggers with topics matching `file:<event>:<directory>` automatically watch the filesystem. The engine starts a watcher on the directory and publishes events to the bus — no extra configuration needed.

Topic format: `file:<event>:<directory>`

Events:
- `file:created:<dir>` — new file appeared in directory
- `file:deleted:<dir>` — file removed from directory
- `file:changed:<dir>` — file modified in directory

`<dir>` is relative to agent root, no leading or trailing slashes. Directory is created automatically if it doesn't exist. Watching is non-recursive (direct children only).

Task input: `{ "event": "created", "filename": "report.csv", "path": "data/imports/report.csv" }`

Examples:
- `file:created:videos` — fires when a new file appears in `videos/`
- `file:deleted:downloads/temp` — fires when a file is removed from `downloads/temp/`
- `file:changed:config` — fires when a file in `config/` is modified

Multiple triggers can use the same topic — each runs its own task. The engine deduplicates watchers per directory. Filtering (by filename, extension, etc.) is done in task code.
