# system.config

App settings are stored in the `config` table of agent.db. Each setting can be set at agent level (in the DB) or globally (in the app's Electron store). The user can manage settings via the command palette.

## Resolution Order

When a setting is read, the app resolves it in this order:

1. **Agent DB** — `config` table in agent.db (per-agent override)
2. **Global Electron store** — app-wide default set by user
3. **Hardcoded default** — built-in fallback

Invalid values at any tier are skipped (falls through to the next tier).

## Schema

```sql
config (key TEXT PRIMARY KEY, value TEXT)
```

Values are stored as JSON-encoded strings. Example:

```js
// Set the HTTP API port to 8080 for this agent
await runSql({ target: 'agent', sql: "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", params: ['httpApi.port', '8080'] })

// Read current value
await runSql({ target: 'agent', sql: "SELECT key, value FROM config" })

// Remove an agent override (falls back to global/default)
await runSql({ target: 'agent', sql: "DELETE FROM config WHERE key = ?", params: ['httpApi.port'] })
```

## Available Settings

| Key | Type | Default | Range | Description |
|-----|------|---------|-------|-------------|
| `backup.intervalHours` | number | 24 | 1–8760 | How often to automatically back up agent.db (in hours) |
| `backup.maxCount` | number | 5 | 1–100 | Maximum number of backups to keep per agent |
| `cleanup.sessionRetentionDays` | number | 30 | 0–3650 | Delete sessions older than this many days (0 = keep forever) |
| `cleanup.taskLogRetentionDays` | number | 30 | 0–3650 | Delete task logs older than this many days (0 = keep forever) |
| `httpApi.port` | number | 9877 | 1–65535 | Preferred port for the local HTTP API server (restart required) |
