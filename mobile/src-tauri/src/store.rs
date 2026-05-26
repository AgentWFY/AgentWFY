// Generic key-value JSON store mirroring desktop/ipc/store.ts.
//
// Single file at `<app_data_dir>/config.json`. TS consumers use the same
// shape as the Electron internal store on desktop, so wrappers like
// `agent-meta.ts` can be ported one-for-one (just async).
//
// Writes are atomic (write tmp, fs::rename) so a mid-write crash leaves
// the prior snapshot intact instead of a half-written object.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value as JsonValue;
use tauri::Manager;

#[derive(Default)]
pub struct StoreState {
    inner: Mutex<()>,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base.join("config.json"))
}

fn read_all(app: &tauri::AppHandle) -> Result<BTreeMap<String, JsonValue>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    // Treat a corrupt file as empty rather than wedging the app — the UI
    // will rewrite the keys it owns on the next set.
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn write_all(app: &tauri::AppHandle, data: &BTreeMap<String, JsonValue>) -> Result<(), String> {
    let path = store_path(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| format!("invalid store path: {}", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("config.json.{}.tmp", std::process::id()));
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn store_get(
    app: tauri::AppHandle,
    state: tauri::State<StoreState>,
    key: String,
) -> Result<Option<JsonValue>, String> {
    let _guard = state.inner.lock().map_err(|e| e.to_string())?;
    let map = read_all(&app)?;
    Ok(map.get(&key).cloned())
}

#[tauri::command]
pub fn store_set(
    app: tauri::AppHandle,
    state: tauri::State<StoreState>,
    key: String,
    value: JsonValue,
) -> Result<(), String> {
    let _guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut map = read_all(&app)?;
    map.insert(key, value);
    write_all(&app, &map)
}

#[tauri::command]
pub fn store_remove(
    app: tauri::AppHandle,
    state: tauri::State<StoreState>,
    key: String,
) -> Result<(), String> {
    let _guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut map = read_all(&app)?;
    if map.remove(&key).is_none() {
        return Ok(());
    }
    write_all(&app, &map)
}
