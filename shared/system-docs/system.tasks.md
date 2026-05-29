# system.tasks

Tasks are JavaScript code stored in the `tasks` table. They run in dedicated Node.js processes (same runtime as execJs) and can be started programmatically or by the user from the command palette.

The `content` column contains JavaScript code to execute. `timeout_ms` is an optional execution timeout (null = no limit).

## APIs

- `startTask({ taskName, input? })` → `{ runId }` — starts the task in a new worker. Non-blocking.
- `stopTask({ runId })` → void — terminates a running task.
- `listTaskRuns({ limit?, offset?, since?, until?, status? })` → `[{ runId, taskName, title, status, origin, startedAt, finishedAt? }]` — recent runs, newest first. Includes both running and finished. `limit` defaults to 20. `since`/`until` filter by finishedAt (or startedAt for running). `status` filters to `running` | `completed` | `failed`.
- `searchTaskRuns({ pattern, ignoreCase?, literal?, limit?, matchesPerRun?, since?, until? })` → `[{ runId, taskName, status, startedAt, matches: [{ where, logIndex?, snippet }] }]` — regex search across each run's `input`, `result`, `error`, and log messages (`where` identifies which field matched). Same regex rules as `grep`. `literal: true` escapes regex metachars. `limit` defaults to 10 runs, `matchesPerRun` to 5.
- `readTaskRun({ runId })` → `{ runId, taskName, title, status, origin, input, startedAt, finishedAt, result, error, logs }` — full run details including all logs. Reads from memory for running runs, from disk for finished runs.

## Input

The optional `input` parameter passed to `startTask` is available as the `input` global variable inside task code.

When a task is triggered (by a trigger or by the user from the command palette), the input is passed automatically:
- **User input**: the user can type optional text when running a task from the command palette
- **HTTP trigger**: `input` is `{ method, path, headers, query, body }`
- **Event trigger**: `input` is the published event data
- **Schedule trigger**: the trigger's `config.input` value (if configured), otherwise no input

## Completion

Task completion is published to the event bus:

```js
const { runId } = await startTask({ taskName: 'my-task', input: 'some input' })
const result = await waitFor({ topic: 'task:run:' + runId })
// result: { runId, taskName, title, status, result, error, logs }
```

For inter-task data passing, use the bus with runId as correlation ID:
```js
// caller
publish({ topic: 'task:' + runId + ':config', data: { key: 'value' } })
// inside task code
const config = await waitFor({ topic: 'task:' + runId + ':config' })
```

## Shortcuts

A task can be bound to a keyboard shortcut by setting `shortcuts.task.<task-name>` in the `config` table to a key combo (e.g. `mod+shift+r`). See system.config for details.
