// The view URI scheme handler is a single, app-wide registration — it
// can't be parameterised per-webview. So it consults this state to know
// which agent's mirror DB to read from. mirror_db_open() sets this; if/when
// multi-agent mobile UX lands, a dedicated setActive command can join it
// (or we encode agentId into the URL hostname, matching desktop's per-agent
// subdomain scheme).

use std::sync::Mutex;

#[derive(Default)]
pub struct ActiveAgent {
    inner: Mutex<Option<String>>,
}

impl ActiveAgent {
    pub fn get(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|g| g.clone())
    }

    pub fn set(&self, agent_id: Option<String>) {
        if let Ok(mut g) = self.inner.lock() {
            *g = agent_id;
        }
    }
}
