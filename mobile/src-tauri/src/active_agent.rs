// The view URI scheme handler is a single, app-wide registration — it can't
// be parameterised per-webview. So it consults this state to know which
// agent's mirror DB to read from (`agent_id`) and where to redirect browser
// asset fetches (`endpoint`).
//
// mirror_db_open() sets the id; the TS-side backend pushes the daemon
// endpoint via `set_active_agent_endpoint` after the WS connects. Pre-connect
// asset requests have no endpoint and return 503 — same shape as the
// pre-snapshot UX for view content.

use std::sync::Mutex;

#[derive(Default)]
pub struct ActiveAgent {
    inner: Mutex<Inner>,
}

#[derive(Default, Clone)]
struct Inner {
    agent_id: Option<String>,
    endpoint: Option<EndpointInfo>,
}

#[derive(Clone)]
pub struct EndpointInfo {
    pub agent_id: String,
    pub base_url: String,
    pub token: String,
}

impl ActiveAgent {
    pub fn get(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|g| g.agent_id.clone())
    }

    pub fn set(&self, agent_id: Option<String>) {
        if let Ok(mut g) = self.inner.lock() {
            g.agent_id = agent_id;
        }
    }

    pub fn endpoint(&self) -> Option<EndpointInfo> {
        self.inner.lock().ok().and_then(|g| g.endpoint.clone())
    }

    pub fn set_endpoint(&self, endpoint: Option<EndpointInfo>) {
        if let Ok(mut g) = self.inner.lock() {
            g.endpoint = endpoint;
        }
    }
}

#[tauri::command]
pub fn set_active_agent_endpoint(
    active: tauri::State<ActiveAgent>,
    agent_id: String,
    base_url: String,
    token: String,
) -> Result<(), String> {
    if agent_id.is_empty() || base_url.is_empty() {
        return Err("set_active_agent_endpoint: agentId and baseUrl required".to_string());
    }
    active.set_endpoint(Some(EndpointInfo {
        agent_id,
        base_url,
        token,
    }));
    Ok(())
}

#[tauri::command]
pub fn clear_active_agent_endpoint(active: tauri::State<ActiveAgent>) {
    active.set_endpoint(None);
}
