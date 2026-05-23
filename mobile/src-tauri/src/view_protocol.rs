// Handler for the agentview:// custom URI scheme. Reads view and module
// content out of the local mirror SQLite and serves it back to the WebView
// so iframes can do `<iframe src="agentview://view/dashboard">`.
//
// Mirrors the subset of desktop/protocol/view-handler.ts that mobile needs.
// File-source views (`?source=file`) and `agentview://asset/*` are
// intentionally deferred — mobile doesn't have a per-agent filesystem to
// serve from, and bundled asset routes can be added when something uses them.

use rusqlite::Connection;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, Wry};

use crate::active_agent::ActiveAgent;
use crate::mirror_db::MirrorDbState;

/// Bootstrap HTML/CSS/JS injected into every view document. Single source of
/// truth is shared/protocol/view-bootstrap.html; the desktop TS path reads
/// it via the codegen'd VIEW_BOOTSTRAP_HTML constant.
const BOOTSTRAP_HTML: &str = include_str!("../../../shared/protocol/view-bootstrap.html");

pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let host = uri.host().unwrap_or("").to_string();
    let name = decode_name(uri.path());

    let app = ctx.app_handle();
    let active: tauri::State<ActiveAgent> = app.state();
    let mirror: tauri::State<MirrorDbState> = app.state();

    let agent_id = match active.get() {
        Some(id) => id,
        None => {
            return html_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "<pre>No active agent — mirror has not been opened yet.</pre>",
            );
        }
    };

    match host.as_str() {
        "view" => serve_view(&mirror, &agent_id, &name),
        "module" => serve_module(&mirror, &agent_id, &name),
        _ => html_response(
            StatusCode::NOT_FOUND,
            &format!(
                "<pre>Unsupported agentview route: {}</pre>",
                html_escape(&host)
            ),
        ),
    }
}

fn serve_view(state: &MirrorDbState, agent_id: &str, name: &str) -> Response<Vec<u8>> {
    if name.is_empty() {
        return html_response(StatusCode::BAD_REQUEST, "<pre>Missing view name</pre>");
    }
    match fetch_single_string(state, agent_id, "SELECT content FROM views WHERE name = ? LIMIT 1", name) {
        Ok(Some(content)) => html_response(StatusCode::OK, &inject_bootstrap(&content, BOOTSTRAP_HTML)),
        Ok(None) => html_response(
            StatusCode::NOT_FOUND,
            &format!("<pre>View not found: {}</pre>", html_escape(name)),
        ),
        Err(err) => html_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("<pre>{}</pre>", html_escape(&err)),
        ),
    }
}

fn serve_module(state: &MirrorDbState, agent_id: &str, name: &str) -> Response<Vec<u8>> {
    if name.is_empty() {
        return text_response(
            StatusCode::BAD_REQUEST,
            "Missing module name",
            "text/plain; charset=utf-8",
        );
    }
    match fetch_single_string(state, agent_id, "SELECT content FROM modules WHERE name = ? LIMIT 1", name) {
        Ok(Some(content)) => text_response(StatusCode::OK, &content, module_content_type(name)),
        Ok(None) => text_response(
            StatusCode::NOT_FOUND,
            &format!("Module not found: {}", name),
            "text/plain; charset=utf-8",
        ),
        Err(err) => text_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &err,
            "text/plain; charset=utf-8",
        ),
    }
}

fn fetch_single_string(
    state: &MirrorDbState,
    agent_id: &str,
    sql: &str,
    name: &str,
) -> Result<Option<String>, String> {
    state.with_connection(agent_id, |conn: &Connection| {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([name]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(row) => row.get::<_, String>(0).map(Some).map_err(|e| e.to_string()),
            None => Ok(None),
        }
    })
}

fn module_content_type(name: &str) -> &'static str {
    if name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "text/javascript; charset=utf-8"
    }
}

/// Mirror of injectBootstrapIntoHtml in shared/protocol/view-document.ts.
fn inject_bootstrap(source: &str, bootstrap: &str) -> String {
    if let Some(idx) = find_case_insensitive(source, "</head>") {
        let mut out = String::with_capacity(source.len() + bootstrap.len());
        out.push_str(&source[..idx]);
        out.push_str(bootstrap);
        out.push_str(&source[idx..]);
        return out;
    }
    if let Some(body_end) = find_body_open_end(source) {
        let mut out = String::with_capacity(source.len() + bootstrap.len());
        out.push_str(&source[..body_end]);
        out.push_str(bootstrap);
        out.push_str(&source[body_end..]);
        return out;
    }
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">{}</head><body>{}</body></html>",
        bootstrap, source
    )
}

fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    let needle_bytes = needle.as_bytes();
    let haystack_bytes = haystack.as_bytes();
    if needle_bytes.is_empty() || haystack_bytes.len() < needle_bytes.len() {
        return None;
    }
    'outer: for i in 0..=haystack_bytes.len() - needle_bytes.len() {
        for j in 0..needle_bytes.len() {
            if !haystack_bytes[i + j].eq_ignore_ascii_case(&needle_bytes[j]) {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

/// Returns the byte index just past the closing `>` of the first `<body...>`
/// tag, ASCII-case-insensitive. Matches the `<body[^>]*>` regex from the TS
/// helper.
fn find_body_open_end(haystack: &str) -> Option<usize> {
    let start = find_case_insensitive(haystack, "<body")?;
    let after_body = start + "<body".len();
    let close_offset = haystack[after_body..].find('>')?;
    Some(after_body + close_offset + 1)
}

fn decode_name(path: &str) -> String {
    let stripped = path.trim_start_matches('/').trim();
    percent_decode(stripped)
}

/// Minimal percent-decoder for view/module names. Tolerates malformed
/// sequences by leaving them as-is (matches `decodeURIComponent`'s lenient
/// behavior in the TS handler — there we'd just call decodeURIComponent and
/// catch).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn html_response(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    build_response(status, body, "text/html; charset=utf-8")
}

fn text_response(status: StatusCode, body: &str, mime: &str) -> Response<Vec<u8>> {
    build_response(status, body, mime)
}

fn build_response(status: StatusCode, body: &str, mime: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .body(body.as_bytes().to_vec())
        .expect("static headers are always valid")
}

fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}
