# system.agents

Spawn and interact with sub-agents.

## Spawning Agents

`spawnAgent({ prompt })` → `{ sessionId }` — spawn a headless sub-agent. It has its own execJs context with the same host APIs. The `sessionId` is a session file name — the agent's conversation is persisted to disk.

When a spawned agent finishes processing, its last assistant response is auto-published to `agent:response:{sessionId}`.

```javascript
const { sessionId } = await spawnAgent({ prompt: 'Analyze the data and return a JSON summary.' })
const { response } = await waitFor({ topic: `agent:response:${sessionId}`, timeoutMs: 120000 })
console.log(response)
```

## Interactive Agents

Use `sendToAgent` to send follow-up messages to a previously spawned agent. The agent loads its conversation from disk, processes the new message, and auto-publishes the response to the same `agent:response:{sessionId}` topic.

- `sendToAgent({ sessionId, message })` → void — sends a message to an existing agent session. Blocks until the agent finishes processing.

```javascript
// Spawn an agent with a system-level instruction
const { sessionId } = await spawnAgent({ prompt: 'You are a trading assistant. Answer questions about portfolio data.' })
await waitFor({ topic: `agent:response:${sessionId}`, timeoutMs: 120000 }) // wait for initial response

// Send follow-up messages (multi-turn conversation)
await sendToAgent({ sessionId, message: 'What is the total P&L for March?' })
const { response } = await waitFor({ topic: `agent:response:${sessionId}`, timeoutMs: 120000 })
console.log(response)

// Continue the conversation — full history is preserved
await sendToAgent({ sessionId, message: 'Break it down by strategy.' })
const { response: r2 } = await waitFor({ topic: `agent:response:${sessionId}`, timeoutMs: 120000 })
console.log(r2)
```

This enables building custom agent chat interfaces in views. The view spawns an agent once, then uses `sendToAgent` + `waitFor` for each user message.
