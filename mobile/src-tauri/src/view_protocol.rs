// Path-based handler for the agentview:// custom URI scheme. Reads view and
// module content out of the local mirror SQLite and serves it back to the
// WebView so iframes can do `<iframe src="agentview://localhost/view/dashboard?tabId=mobile">`.
//
// iOS WKWebView blocks WKURLSchemeHandler from claiming http/https, so we
// can't mirror desktop's https-interception trick on mobile. A custom scheme
// is the only available transport — but agents never see it, because they
// emit scheme-free `/view/<name>` markdown links and views use relative
// paths. The hostname is ignored; routing is by first path segment.
//
// File-source fetches (`<img src="/screenshots/foo.png">` inside a view) and
// `/file/<path>` redirect to a short-lived HMAC-signed daemon URL — the same
// scheme desktop uses, reimplemented in Rust here. Asset routes (`/asset/*`)
// are intentionally deferred; mobile has no bundled assets on the daemon.

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use rusqlite::Connection;
use sha2::Sha256;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, Wry};

use crate::active_agent::{ActiveAgent, EndpointInfo};
use crate::mirror_db::MirrorDbState;

type HmacSha256 = Hmac<Sha256>;

/// Bootstrap HTML/CSS/JS injected into every view document. Single source of
/// truth is shared/protocol/view-bootstrap.html; the desktop TS path reads
/// it via the codegen'd VIEW_BOOTSTRAP_HTML constant.
const BOOTSTRAP_HTML: &str = include_str!("../../../shared/protocol/view-bootstrap.html");

/// Mirrors DEFAULT_SIGNED_URL_TTL_MS / 1000 in shared/backend/signed-urls.ts.
const SIGNED_URL_TTL_SECS: i64 = 60;

pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let path = uri.path();
    let query = uri.query().unwrap_or("");

    let app = ctx.app_handle();
    let active: tauri::State<ActiveAgent> = app.state();
    let mirror: tauri::State<MirrorDbState> = app.state();

    let parsed = split_path(path);

    // Doc / module routes hit the local mirror.
    if let Some((kind, target)) = parsed.as_ref() {
        match *kind {
            "module" => {
                return match active.get() {
                    Some(id) => serve_module(&mirror, &id, target),
                    None => no_active_agent_html(),
                };
            }
            "view" if is_view_document_request(target, query) => {
                return match active.get() {
                    Some(id) => serve_view(&mirror, &id, target),
                    None => no_active_agent_html(),
                };
            }
            "asset" => {
                // Bundled client assets aren't replicated to mobile.
                return text_response(
                    StatusCode::NOT_FOUND,
                    &format!("Asset not available on mobile: {}", target),
                    "text/plain; charset=utf-8",
                );
            }
            _ => {}
        }
    }

    // File-source fallback: bare paths, /file/<path>, and view sub-resource
    // fetches all redirect to the daemon. The browser follows the 302 and
    // pulls bytes directly over HTTP — no base64-over-WS pumping.
    let rel_path = match parsed {
        Some((_, target)) => target,
        None => path.trim_start_matches('/').to_string(),
    };
    if rel_path.is_empty() {
        return text_response(
            StatusCode::NOT_FOUND,
            "Empty path",
            "text/plain; charset=utf-8",
        );
    }

    redirect_to_daemon(&active, &rel_path)
}

fn redirect_to_daemon(active: &ActiveAgent, rel_path: &str) -> Response<Vec<u8>> {
    let Some(endpoint) = active.endpoint() else {
        return text_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Daemon endpoint not registered — connect first.",
            "text/plain; charset=utf-8",
        );
    };
    let exp = now_seconds().saturating_add(SIGNED_URL_TTL_SECS);
    let location = sign_file_url(&endpoint, rel_path, exp);
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("static headers are always valid")
}

/// Mirror of signFileUrl in shared/backend/signed-urls.ts. The HMAC is over
/// the canonical (decoded) relPath so encoding asymmetries between this
/// helper and JS's encodeURIComponent don't break verification.
fn sign_file_url(endpoint: &EndpointInfo, rel_path: &str, exp: i64) -> String {
    let payload = format!("GET\n{}\n{}\n{}", endpoint.agent_id, rel_path, exp);
    let mut mac = HmacSha256::new_from_slice(endpoint.token.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());
    let encoded_agent = percent_encode_segment(&endpoint.agent_id);
    let encoded_path = encode_rel_path(rel_path);
    let base = endpoint.base_url.trim_end_matches('/');
    format!(
        "{}/agent/{}/files/{}?sig={}&exp={}",
        base, encoded_agent, encoded_path, sig, exp
    )
}

fn encode_rel_path(rel_path: &str) -> String {
    rel_path
        .split('/')
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// Encodes everything outside JS's `encodeURIComponent` unreserved set
/// (A-Z a-z 0-9 - _ . ! ~ * ' ( )). Operates on UTF-8 bytes so non-ASCII
/// filenames percent-encode their byte sequences correctly.
fn percent_encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        if is_unreserved(byte) {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(hex_high(byte));
            out.push(hex_low(byte));
        }
    }
    out
}

fn is_unreserved(byte: u8) -> bool {
    matches!(
        byte,
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
    )
}

fn hex_high(byte: u8) -> char {
    HEX[(byte >> 4) as usize]
}

fn hex_low(byte: u8) -> char {
    HEX[(byte & 0x0F) as usize]
}

const HEX: [char; 16] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F',
];

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn no_active_agent_html() -> Response<Vec<u8>> {
    html_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "<pre>No active agent — mirror has not been opened yet.</pre>",
    )
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

/// Mirror of parseAgentPath in shared/protocol/view-document.ts.
/// Returns (kind, target) where kind is "view"/"module"/"file"/"asset" and
/// target is the percent-decoded remainder. The kind reference is returned as
/// a &'static str slice of the original path so the caller can match cheaply.
fn split_path(path: &str) -> Option<(&'static str, String)> {
    let stripped = path.trim_start_matches('/').trim();
    if stripped.is_empty() {
        return None;
    }
    let (head, tail) = stripped.split_once('/')?;
    let kind: &'static str = match head {
        "view" => "view",
        "module" => "module",
        "file" => "file",
        "asset" => "asset",
        _ => return None,
    };
    let target = percent_decode(tail.trim());
    if target.is_empty() {
        return None;
    }
    Some((kind, target))
}

/// Mirror of isViewDocumentUrl in shared/protocol/view-document.ts.
/// Documents carry `tabId`; sub-resource fetches resolve relative to the view
/// URL and never inherit query params, so tabId reliably distinguishes them.
fn is_view_document_request(target: &str, query: &str) -> bool {
    if has_query_key(query, "tabId") {
        return true;
    }
    !target.contains('/') && !target.contains('.')
}

fn has_query_key(query: &str, key: &str) -> bool {
    if query.is_empty() {
        return false;
    }
    for pair in query.split('&') {
        let name = pair.split_once('=').map(|(k, _)| k).unwrap_or(pair);
        if name == key {
            return true;
        }
    }
    false
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
