# system.config

App settings are stored in the `config` table of agent.db. Each setting can be set at agent level (in the DB) or globally (in the app's Electron store). The user can manage settings via the command palette.

## Naming Convention

- `system.*` — built-in system settings, synced on startup
- `plugin.*` — plugin settings, installed/uninstalled with plugins
- Other names — user-defined settings

System and plugin config rows cannot be inserted or deleted by the agent, but their `value` can be updated.

## Resolution Order

When a setting is read, the app resolves it in this order:

1. **Agent DB** — `config` table `value` column (per-agent override, non-NULL)
2. **Global Electron store** — app-wide default set by user
3. **Consumer fallback** — hardcoded default in the code that reads the setting

Set `value = NULL` to revert a setting to the global/default.

## Schema

```sql
config (name TEXT PRIMARY KEY, value TEXT, description TEXT NOT NULL DEFAULT '')
```

- `name` — unique setting identifier
- `value` — JSON-encoded value, or NULL (no override, use global/default)
- `description` — human-readable description including default value info

## SQL Examples

```js
// Read all config
await runSql({ target: 'agent', sql: "SELECT name, value, description FROM config" })

// Update a system setting
await runSql({ target: 'agent', sql: "UPDATE config SET value = ? WHERE name = ?", params: ['"8080"', 'system.httpApi.port'] })

// Revert a setting to default (set value to NULL)
await runSql({ target: 'agent', sql: "UPDATE config SET value = NULL WHERE name = ?", params: ['system.httpApi.port'] })

// Add a custom user setting
await runSql({ target: 'agent', sql: "INSERT INTO config (name, value, description) VALUES (?, ?, ?)", params: ['myKey', '"myValue"', 'My custom setting'] })

// Delete a custom user setting
await runSql({ target: 'agent', sql: "DELETE FROM config WHERE name = ?", params: ['myKey'] })
```

## System Settings

| Name | Default | Description |
|------|---------|-------------|
| `system.defaultView` | home | Name of the view to open on startup |
| `system.backup.intervalHours` | 24 | How often to back up agent.db in hours |
| `system.backup.maxCount` | 5 | Maximum number of backups to keep |
| `system.cleanup.sessionRetentionDays` | 30 | Delete sessions older than this many days, 0 = keep forever |
| `system.cleanup.taskLogRetentionDays` | 30 | Delete task logs older than this many days, 0 = keep forever |
| `system.httpApi.port` | 9877 | Preferred port for the local HTTP API server, restart required |
