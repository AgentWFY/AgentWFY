# system.tasks

Tasks are JavaScript code stored in the `tasks` table. They run in dedicated Node.js processes (same runtime as execJs) and can be started programmatically or by the user from the command palette.

The `content` column contains JavaScript code to execute. `timeout_ms` is an optional execution timeout (null = no limit).

## APIs

- `startTask({ taskName, input? })` → `{ runId }` — starts the task in a new worker. Non-blocking.
- `stopTask({ runId })` → void — terminates a running task.

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
