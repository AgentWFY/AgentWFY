# system.sessions

Spawn and interact with sessions.

## Spawning Sessions

`spawnSession({ prompt, providerId? })` → `{ sessionId }` — spawn a session. It runs independently with its own execJs context and the same host APIs. The `sessionId` is a session file name — the conversation is persisted to disk. Pass `providerId` to use a specific provider instead of the default.

When a spawned session finishes processing, its last assistant response is auto-published to `session:response:{sessionId}`.

```javascript
const { sessionId } = await spawnSession({ prompt: 'Analyze the data and return a JSON summary.' })
const { response } = await waitFor({ topic: `session:response:${sessionId}`, timeoutMs: 120000 })
console.log(response)
```

## Multi-turn Sessions

Use `sendToSession` to send follow-up messages to a previously spawned session. The session loads its conversation from disk, processes the new message, and auto-publishes the response to the same `session:response:{sessionId}` topic.

- `sendToSession({ sessionId, message })` → void — sends a message to an existing session. Blocks until the session finishes processing.

```javascript
// Spawn a session with a system-level instruction
const { sessionId } = await spawnSession({ prompt: 'You are a trading assistant. Answer questions about portfolio data.' })
await waitFor({ topic: `session:response:${sessionId}`, timeoutMs: 120000 }) // wait for initial response

// Send follow-up messages (multi-turn conversation)
await sendToSession({ sessionId, message: 'What is the total P&L for March?' })
const { response } = await waitFor({ topic: `session:response:${sessionId}`, timeoutMs: 120000 })
console.log(response)

// Continue the conversation — full history is preserved
await sendToSession({ sessionId, message: 'Break it down by strategy.' })
const { response: r2 } = await waitFor({ topic: `session:response:${sessionId}`, timeoutMs: 120000 })
console.log(r2)
```

## Opening Sessions in Chat

`openSessionInChat({ sessionId })` → void — opens a spawned session in the main chat panel. Works for both running and finished sessions.

## Providers

`getAvailableProviders()` → `[{ id, name }]` — list registered LLM providers. Use with `spawnSession` to run a session on a specific provider.
