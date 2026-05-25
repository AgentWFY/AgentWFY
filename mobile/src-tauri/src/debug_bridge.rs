// Debug-only HTTP bridge that lets `scripts/mobile-preview --eval` run JS
// expressions inside the WebView. Listens on a UNIX socket inside the app's
// sandbox (host reaches it through simctl get_app_container) because the iOS
// Simulator's loopback isn't shared with the host. Wire format is plain
// HTTP/1.1 over the socket: POST /eval with { "expression": "..." } returns
// { "ok": true/false, "value"/"error" }. Compiled out of release builds via
// cfg(debug_assertions).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;


use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

// sockaddr_un on macOS caps sun_path at 104 bytes — the sim's sandbox path
// alone blows past that, so the socket lives in /tmp/. On the iOS Simulator
// the app runs as the macOS user and can write to /tmp/; the host side reads
// from the same /tmp/ since both share the host's filesystem.
//
// Path is namespaced by the simulator UDID so parallel previews don't
// clobber each other's socket. SIMULATOR_UDID is set by simctl on launch.
const SOCKET_PREFIX: &str = "/tmp/agentwfy-mobile-debug-bridge-";
const SOCKET_SUFFIX: &str = ".sock";

fn socket_path() -> PathBuf {
    let udid = std::env::var("SIMULATOR_UDID").unwrap_or_else(|_| "unknown".into());
    PathBuf::from(format!("{SOCKET_PREFIX}{udid}{SOCKET_SUFFIX}"))
}

type EvalResult = Result<Value, String>;

#[derive(Default)]
pub struct DebugBridge {
    pending: Mutex<HashMap<u64, Sender<EvalResult>>>,
    next_id: Mutex<u64>,
}

impl DebugBridge {
    fn assign_id(&self) -> u64 {
        let mut n = self.next_id.lock().unwrap();
        *n += 1;
        *n
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn __debug_result(
    state: tauri::State<'_, Arc<DebugBridge>>,
    id: u64,
    value: Value,
    error: Option<String>,
) {
    let tx = state.pending.lock().unwrap().remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(match error {
            Some(e) => Err(e),
            None => Ok(value),
        });
    }
}

pub fn start(app: AppHandle, bridge: Arc<DebugBridge>) {
    let path = socket_path();
    // Stale socket from a previous run blocks bind; remove it.
    let _ = fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[debug-bridge] bind {} failed: {e}", path.display());
            return;
        }
    };
    eprintln!("[debug-bridge] listening on {}", path.display());

    std::thread::Builder::new()
        .name("agentwfy-debug-bridge".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[debug-bridge] accept error: {e}");
                        continue;
                    }
                };
                let app = app.clone();
                let bridge = bridge.clone();
                std::thread::spawn(move || handle(stream, app, bridge));
            }
        })
        .expect("spawn debug-bridge thread");
}

fn handle(mut stream: UnixStream, app: AppHandle, bridge: Arc<DebugBridge>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];

    // Phase 1: read until \r\n\r\n so we have the full headers.
    let mut header_end: Option<usize> = None;
    while header_end.is_none() {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                header_end = (0..buf.len().saturating_sub(3))
                    .find(|i| &buf[*i..*i + 4] == b"\r\n\r\n")
                    .map(|i| i + 4);
            }
            Err(_) => break,
        }
    }
    let Some(header_end) = header_end else {
        write_response(&mut stream, 400, &json!({ "ok": false, "error": "no request headers" }).to_string());
        return;
    };

    let header_text = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let path = header_text.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
    if path != "/eval" {
        write_response(&mut stream, 404, &json!({ "ok": false, "error": "unknown path" }).to_string());
        return;
    }

    // Phase 2: parse Content-Length, then keep reading until we have that
    // many body bytes. Bail if no Content-Length — we don't speak chunked.
    let content_length: usize = header_text
        .lines()
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim())))
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);

    while buf.len() - header_end < content_length {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }
    let body_bytes = &buf[header_end..header_end + content_length.min(buf.len() - header_end)];
    let body = std::str::from_utf8(body_bytes).unwrap_or("");

    let payload: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            write_response(&mut stream, 400, &json!({ "ok": false, "error": format!("bad JSON: {e}") }).to_string());
            return;
        }
    };
    let expression = match payload.get("expression").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            write_response(&mut stream, 400, &json!({ "ok": false, "error": "missing expression" }).to_string());
            return;
        }
    };

    let id = bridge.assign_id();
    let (tx, rx) = channel::<EvalResult>();
    bridge.pending.lock().unwrap().insert(id, tx);

    let webview = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            bridge.pending.lock().unwrap().remove(&id);
            write_response(&mut stream, 500, &json!({ "ok": false, "error": "no main webview" }).to_string());
            return;
        }
    };

    // Match the desktop preview's eval semantics: try as an expression first
    // (so `await x` returns x), fall back to treating the input as a function
    // body so multi-statement snippets with explicit `return` still work.
    let code_literal = serde_json::to_string(&expression).unwrap();
    let js = format!(
        r#"(async () => {{
            const __id = {id};
            const __code = {code_literal};
            const __invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
                || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
            try {{
                const __AsyncFn = (async function(){{}}).constructor;
                let __fn;
                try {{ __fn = new __AsyncFn('return (\n' + __code + '\n);'); }}
                catch (__err) {{ if (!(__err instanceof SyntaxError)) throw __err; __fn = new __AsyncFn(__code); }}
                const __result = await __fn();
                await __invoke('__debug_result', {{ id: __id, value: __result === undefined ? null : __result, error: null }});
            }} catch (__err) {{
                await __invoke('__debug_result', {{ id: __id, value: null, error: String(__err && __err.stack || __err) }});
            }}
        }})();"#
    );

    if let Err(e) = webview.eval(js) {
        bridge.pending.lock().unwrap().remove(&id);
        write_response(&mut stream, 500, &json!({ "ok": false, "error": format!("eval inject failed: {e}") }).to_string());
        return;
    }

    let result = rx.recv_timeout(Duration::from_secs(30));
    // Clean up if the channel was dropped or timed out.
    bridge.pending.lock().unwrap().remove(&id);

    let body = match result {
        Ok(Ok(v)) => json!({ "ok": true, "value": v }).to_string(),
        Ok(Err(e)) => json!({ "ok": false, "error": e }).to_string(),
        Err(_) => json!({ "ok": false, "error": "eval timed out after 30s" }).to_string(),
    };
    write_response(&mut stream, 200, &body);
}

fn write_response(stream: &mut UnixStream, status: u16, body: &str) {
    let phrase = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Status",
    };
    let response = format!(
        "HTTP/1.1 {status} {phrase}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}
