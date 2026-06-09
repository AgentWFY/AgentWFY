mod active_agent;
#[cfg(debug_assertions)]
mod debug_bridge;
mod mirror_db;
mod store;
mod view_protocol;

use active_agent::{clear_active_agent_endpoint, set_active_agent_endpoint, ActiveAgent};
use mirror_db::{
    mirror_db_apply_change, mirror_db_open, mirror_db_query, mirror_db_remove_agent,
    mirror_db_replace_snapshot, MirrorDbState,
};
use store::{store_get, store_remove, store_set, StoreState};

#[cfg(debug_assertions)]
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    let bridge = Arc::new(debug_bridge::DebugBridge::default());

    let builder = tauri::Builder::default()
        .manage(MirrorDbState::default())
        .manage(ActiveAgent::default())
        .manage(StoreState::default())
        .register_uri_scheme_protocol("agentview", view_protocol::handle);

    #[cfg(debug_assertions)]
    let builder = builder.manage(bridge.clone());

    let builder = builder.invoke_handler({
        #[cfg(debug_assertions)]
        {
            tauri::generate_handler![
                mirror_db_open,
                mirror_db_query,
                mirror_db_apply_change,
                mirror_db_replace_snapshot,
                mirror_db_remove_agent,
                set_active_agent_endpoint,
                clear_active_agent_endpoint,
                store_get,
                store_set,
                store_remove,
                debug_bridge::__debug_result,
            ]
        }
        #[cfg(not(debug_assertions))]
        {
            tauri::generate_handler![
                mirror_db_open,
                mirror_db_query,
                mirror_db_apply_change,
                mirror_db_replace_snapshot,
                mirror_db_remove_agent,
                set_active_agent_endpoint,
                clear_active_agent_endpoint,
                store_get,
                store_set,
                store_remove,
            ]
        }
    });

    #[cfg(debug_assertions)]
    let builder = builder.setup({
        let bridge = bridge.clone();
        move |app| {
            debug_bridge::start(app.handle().clone(), bridge);
            Ok(())
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
