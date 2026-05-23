// Local SQLite mirror of the daemon's agent DB.
//
// The daemon is the source of truth; this module just maintains a read mirror
// that the TS-side state machine in mobile/src/remote-mirror.ts drives via
// four Tauri commands:
//
//   mirror_db_open                — open an existing mirror file, or report
//                                   not_initialized so the TS side fetches a
//                                   snapshot first
//   mirror_db_query               — read-only SELECTs for the UI / agentview://
//   mirror_db_apply_change        — apply one daemon-emitted AgentDbChange
//   mirror_db_replace_snapshot    — atomic file-replace from a daemon snapshot
//
// The schema travels with snapshot bytes — Rust never executes CREATE TABLE.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params_from_iter, types::Value as SqlValue, types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use tauri::{Manager, State};

use crate::active_agent::ActiveAgent;

/// Tables replicated from the daemon. Must match
/// `CHANGE_TRACKED_TABLES` in shared/db/agent-db.ts.
const CHANGE_TRACKED_TABLES: &[&str] = &[
    "views", "docs", "tasks", "triggers", "config", "plugins", "modules",
];

#[derive(Default)]
pub struct MirrorDbState {
    inner: Mutex<HashMap<String, Connection>>,
}

impl MirrorDbState {
    /// Run a read-only operation against the mirror connection for `agent_id`.
    /// Used by the agentview:// scheme handler in view_protocol.rs.
    pub fn with_connection<T>(
        &self,
        agent_id: &str,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        let conn = guard
            .get(agent_id)
            .ok_or_else(|| format!("mirror not open for agent {}", agent_id))?;
        f(conn)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    /// "ready" — mirror file exists and is open.
    /// "not_initialized" — no mirror file yet; caller must replace_snapshot.
    pub status: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeWire {
    pub table: String,
    pub row_id: JsonValue,
    pub op: String,
    #[serde(default)]
    pub previous_row_id: Option<JsonValue>,
    // The state machine on the TS side is the source of truth for version
    // sequencing; Rust just stores rows. Kept on the wire shape so a future
    // Rust-side sanity check is a one-liner away.
    #[serde(default)]
    #[allow(dead_code)]
    pub version: u64,
    #[serde(default)]
    pub row: Option<Map<String, JsonValue>>,
}

fn agent_dir(app: &tauri::AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("agents").join(agent_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn db_path(app: &tauri::AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    Ok(agent_dir(app, agent_id)?.join("agent.db"))
}

fn open_connection(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub fn mirror_db_open(
    app: tauri::AppHandle,
    state: State<MirrorDbState>,
    active: State<ActiveAgent>,
    agent_id: String,
) -> Result<OpenResult, String> {
    let path = db_path(&app, &agent_id)?;
    let mut map = state.inner.lock().map_err(|e| e.to_string())?;
    if !path.exists() {
        map.remove(&agent_id);
        // Don't bump active here — the caller is about to snapshot+reopen.
        return Ok(OpenResult { status: "not_initialized" });
    }
    let conn = open_connection(&path)?;
    map.insert(agent_id.clone(), conn);
    active.set(Some(agent_id));
    Ok(OpenResult { status: "ready" })
}

#[tauri::command]
pub fn mirror_db_query(
    state: State<MirrorDbState>,
    agent_id: String,
    sql: String,
    params: Option<Vec<JsonValue>>,
) -> Result<Vec<Map<String, JsonValue>>, String> {
    let map = state.inner.lock().map_err(|e| e.to_string())?;
    let conn = map
        .get(&agent_id)
        .ok_or_else(|| format!("mirror not open for agent {}", agent_id))?;

    let sql_params: Vec<SqlValue> = params
        .unwrap_or_default()
        .iter()
        .map(json_to_sql)
        .collect::<Result<_, _>>()?;

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let column_names: Vec<String> =
        stmt.column_names().into_iter().map(String::from).collect();
    let rows = stmt
        .query_map(params_from_iter(sql_params), |row| {
            let mut obj = Map::with_capacity(column_names.len());
            for (i, name) in column_names.iter().enumerate() {
                obj.insert(name.clone(), sql_value_ref_to_json(row.get_ref(i)?));
            }
            Ok(obj)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn mirror_db_apply_change(
    state: State<MirrorDbState>,
    agent_id: String,
    change: ChangeWire,
) -> Result<(), String> {
    if !CHANGE_TRACKED_TABLES.contains(&change.table.as_str()) {
        return Err(format!("applyMirrorChange: untracked table {}", change.table));
    }

    let map = state.inner.lock().map_err(|e| e.to_string())?;
    let conn = map
        .get(&agent_id)
        .ok_or_else(|| format!("mirror not open for agent {}", agent_id))?;

    let row_id_sql = json_to_sql(&change.row_id)?;

    if change.op == "delete" {
        let sql = format!("DELETE FROM {} WHERE name = ?", change.table);
        conn.execute(&sql, [row_id_sql]).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let row = change.row.as_ref().ok_or_else(|| {
        format!(
            "applyMirrorChange: missing row data for {} on {}",
            change.op, change.table
        )
    })?;
    if row.is_empty() {
        return Err(format!(
            "applyMirrorChange: empty row for {} on {}",
            change.op, change.table
        ));
    }

    // Same pattern as desktop's withoutAutoUpdatedAtTrigger — drop the
    // updated_at maintenance trigger so the daemon-supplied updated_at
    // column lands as-is, then recreate it. The auto trigger is a
    // persistent (non-TEMP) one, so it travels via the snapshot file.
    let drop_sql = format!("DROP TRIGGER IF EXISTS {}_auto_updated_at", change.table);
    conn.execute(&drop_sql, []).map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        let cols: Vec<&String> = row.keys().collect();
        let values: Vec<SqlValue> = cols
            .iter()
            .map(|c| json_to_sql(&row[c.as_str()]))
            .collect::<Result<_, _>>()?;

        // Rename path: if the daemon changed the primary key (`name`), try
        // updating the existing row in place first. If that misses (e.g. the
        // mirror never saw the original row), fall through to upsert.
        if change.op == "update" {
            if let Some(prev) = change.previous_row_id.as_ref() {
                if prev != &change.row_id {
                    let set_clause = cols
                        .iter()
                        .map(|c| format!("{} = ?", c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let sql = format!(
                        "UPDATE {} SET {} WHERE name = ?",
                        change.table, set_clause
                    );
                    let mut bind: Vec<SqlValue> = values.clone();
                    bind.push(json_to_sql(prev)?);
                    let changed = conn
                        .execute(&sql, params_from_iter(bind))
                        .map_err(|e| e.to_string())?;
                    if changed > 0 {
                        return Ok(());
                    }
                }
            }
        }

        let cols_csv = cols
            .iter()
            .map(|c| c.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = std::iter::repeat_n("?", cols.len())
            .collect::<Vec<_>>()
            .join(", ");
        let set_excluded = cols
            .iter()
            .filter(|c| c.as_str() != "name")
            .map(|c| format!("{} = excluded.{}", c, c))
            .collect::<Vec<_>>()
            .join(", ");
        let conflict = if set_excluded.is_empty() {
            "ON CONFLICT(name) DO NOTHING".to_string()
        } else {
            format!("ON CONFLICT(name) DO UPDATE SET {}", set_excluded)
        };
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({}) {}",
            change.table, cols_csv, placeholders, conflict
        );
        conn.execute(&sql, params_from_iter(values))
            .map_err(|e| e.to_string())?;
        Ok(())
    })();

    let recreate_sql = format!(
        "CREATE TRIGGER IF NOT EXISTS {table}_auto_updated_at AFTER UPDATE ON {table} \
         BEGIN \
           UPDATE {table} SET updated_at = unixepoch() WHERE rowid = NEW.rowid; \
         END",
        table = change.table
    );
    conn.execute(&recreate_sql, [])
        .map_err(|e| e.to_string())?;

    result
}

#[tauri::command]
pub fn mirror_db_replace_snapshot(
    app: tauri::AppHandle,
    state: State<MirrorDbState>,
    active: State<ActiveAgent>,
    agent_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let path = db_path(&app, &agent_id)?;
    {
        let mut map = state.inner.lock().map_err(|e| e.to_string())?;
        map.remove(&agent_id);
    }

    let dir = path
        .parent()
        .ok_or_else(|| format!("invalid db path: {}", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let tmp = dir.join(format!("agent.db.snapshot.{}.tmp", std::process::id()));
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

    let _ = fs::remove_file(path.with_extension("db-wal"));
    let _ = fs::remove_file(path.with_extension("db-shm"));

    let conn = open_connection(&path)?;
    state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .insert(agent_id.clone(), conn);
    active.set(Some(agent_id));
    Ok(())
}

fn json_to_sql(value: &JsonValue) -> Result<SqlValue, String> {
    Ok(match value {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(format!("cannot bind JSON number: {}", n));
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        // Composite shapes shouldn't appear in replicated rows, but keep the
        // path total so a stray JSON object lands as a TEXT value rather than
        // panicking the daemon→mobile sync.
        JsonValue::Array(_) | JsonValue::Object(_) => SqlValue::Text(value.to_string()),
    })
}

fn sql_value_ref_to_json(value: ValueRef<'_>) -> JsonValue {
    match value {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(i) => JsonValue::from(i),
        ValueRef::Real(f) => JsonValue::from(f),
        ValueRef::Text(t) => JsonValue::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => JsonValue::Array(b.iter().map(|byte| JsonValue::from(*byte)).collect()),
    }
}
