mod active_agent;
mod mirror_db;
mod view_protocol;

use active_agent::{clear_active_agent_endpoint, set_active_agent_endpoint, ActiveAgent};
use mirror_db::{
    mirror_db_apply_change, mirror_db_open, mirror_db_query, mirror_db_replace_snapshot,
    MirrorDbState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MirrorDbState::default())
        .manage(ActiveAgent::default())
        .register_uri_scheme_protocol("agentview", view_protocol::handle)
        .invoke_handler(tauri::generate_handler![
            mirror_db_open,
            mirror_db_query,
            mirror_db_apply_change,
            mirror_db_replace_snapshot,
            set_active_agent_endpoint,
            clear_active_agent_endpoint,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
