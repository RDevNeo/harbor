//! The `gmail` MCP server: the user's Gmail for the agents Harbor starts, once they sign in
//! to Gmail under Settings › Integrations › Apps (mcp.rs, `Auth::Google`).
//!
//! Agents' configs start it as `harbor app gmail` (stdio; the bridge runs it here for turns
//! on other devices). It reads the access token from Harbor's store and refreshes it there,
//! so no token is in a config, an env var or a command line: curl reads the Authorization
//! header from a 0600 file in the store. Tools call Gmail's REST API and answer in compact
//! text: bodies decoded from MIME (text/plain first, else the HTML as text), attachments
//! listed with their ids. Search uses Gmail's own query syntax.
//!
//! Several Google accounts can be signed in at once: every tool takes `account` (an address;
//! default: the default account), `accounts` lists them, and `search` also takes "all".

use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// The server's name, as the agent sees it (`mcp__gmail__search`…), and the app's id.
pub const NAME: &str = "gmail";
const API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD: &str = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
/// A message bigger than this goes up as a multipart upload instead of base64url in JSON.
const RAW_MAX: usize = 4 << 20;
/// Requests made at once for a listing.
const PARALLEL: usize = 8;
/// System labels, also when the label list can't be fetched.
const SYSTEM: &[&str] = &["INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT"];

// ------------------------------------------------------------------ server

/// Serves the tools on stdin/stdout until the agent's turn ends.
pub fn run() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = req.get("id").cloned() else { continue }; // notifications need no answer
        let result = match req["method"].as_str().unwrap_or("") {
            "initialize" => json!({
                "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": NAME, "version": env!("CARGO_PKG_VERSION") },
            }),
            "tools/list" => json!({ "tools": tools() }),
            "tools/call" => {
                let (ok, text) = match call_tool(req["params"]["name"].as_str().unwrap_or(""), &req["params"]["arguments"]) {
                    Ok(t) => (true, t),
                    Err(e) => (false, e),
                };
                json!({ "content": [{ "type": "text", "text": text }], "isError": !ok })
            }
            "ping" => json!({}),
            _ => {
                if writeln!(out, "{}", json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })).and_then(|_| out.flush()).is_err() {
                    break;
                }
                continue;
            }
        };
        // The client went away: finish the stdio server without a panic or SIGPIPE.
        if writeln!(out, "{}", json!({ "jsonrpc": "2.0", "id": id, "result": result })).and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

fn s(d: &str) -> Value {
    json!({ "type": "string", "description": d })
}

fn int(d: &str) -> Value {
    json!({ "type": "integer", "description": d })
}

fn flag(d: &str) -> Value {
    json!({ "type": "boolean", "description": d })
}

fn list(d: &str) -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": d })
}

fn tool(name: &str, desc: &str, props: Value, required: &[&str]) -> Value {
    json!({ "name": name, "description": desc, "inputSchema": { "type": "object", "properties": props, "required": required } })
}

/// The fields of a message to send or keep as a draft.
fn mail_props(extra: Value) -> Value {
    let mut m: Map<String, Value> = json!({
        "to": s("Recipients, comma-separated (\"Ana <ana@example.com>, bo@example.com\")"),
        "cc": s("Cc recipients, comma-separated"),
        "bcc": s("Bcc recipients, comma-separated"),
        "subject": s("Subject (a reply defaults to \"Re: \" + the original's)"),
        "body": s("Plain-text body"),
        "html": s("HTML body (optional; the plain text goes along as the alternative)"),
        "attachments": list("Paths of files to attach, on the PC that runs Harbor"),
        "reply_to": s("Id of the message this answers: threads it into that conversation and fills recipients and subject when not given"),
        "reply_all": flag("With reply_to: also copy the original's other recipients"),
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    m.extend(extra.as_object().cloned().unwrap_or_default());
    Value::Object(m)
}

/// The label changes `modify` and `filters` share.
fn label_props(extra: Value) -> Value {
    let mut m: Map<String, Value> = json!({
        "move_to": s("Label to move to, like moving to a folder: adds it and takes the mail out of the inbox (\"INBOX\" moves it back)"),
        "add_labels": list("Labels to add, by name or id"),
        "remove_labels": list("Labels to remove, by name or id"),
        "archive": flag("true: take out of the inbox"),
        "read": flag("true: mark read; false: mark unread"),
        "starred": flag("true: star; false: unstar"),
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    m.extend(extra.as_object().cloned().unwrap_or_default());
    Value::Object(m)
}

pub fn tools() -> Vec<Value> {
    let mut v = vec![
        tool(
            "search",
            "Search the user's Gmail with Gmail's search syntax: from:, to:, subject:, is:unread, is:starred, has:attachment, label:, in:inbox, in:sent, newer_than:7d, after:2026/01/31, \"exact phrase\", OR, -word. Newest first: ids, date, sender, subject, labels and a snippet. threads: true lists whole conversations instead of single messages.",
            json!({
                "query": s("Gmail search query (empty: everything but spam and trash)"),
                "max_results": int("How many (default 20, at most 100)"),
                "page_token": s("The page_token a previous search returned, for the next page"),
                "threads": flag("List conversations instead of messages"),
                "include_spam_trash": flag("Also search spam and trash"),
            }),
            &[],
        ),
        tool(
            "get_message",
            "Read one message: headers, labels, its text (the plain-text part, or the HTML as text) and its attachments with the ids get_attachment needs.",
            json!({ "id": s("Message id"), "max_chars": int("Longest body returned (default 20000)") }),
            &["id"],
        ),
        tool(
            "get_thread",
            "Read a whole conversation, oldest message first, each shown as get_message shows it.",
            json!({ "id": s("Thread id"), "max_chars": int("Longest body returned per message (default 8000)") }),
            &["id"],
        ),
        tool(
            "get_attachment",
            "Save an attachment to a file on the PC that runs Harbor and return its path. Pass the filename get_message listed with it.",
            json!({
                "message_id": s("Message id"),
                "attachment_id": s("The attachment_id get_message listed"),
                "filename": s("The attachment's filename"),
                "path": s("File or folder to save to (default: a harbor-gmail folder in the temp dir)"),
            }),
            &["message_id", "attachment_id"],
        ),
        tool(
            "send",
            "Send an email from the user's Gmail. To answer in the same conversation pass reply_to (the message id you answer): recipients, subject and threading come from it unless given. Only send what the user asked for; when unsure, save_draft instead.",
            mail_props(json!({})),
            &[],
        ),
        tool(
            "save_draft",
            "Save a draft the user can review in Gmail, or replace draft_id's content. Same fields as send.",
            mail_props(json!({ "draft_id": s("Draft to replace (from list_drafts or an earlier save_draft)") })),
            &[],
        ),
        tool(
            "list_drafts",
            "The user's drafts: draft id, recipients, subject, snippet.",
            json!({ "query": s("Gmail search query to filter them"), "max_results": int("How many (default 20, at most 100)") }),
            &[],
        ),
        tool("send_draft", "Send a saved draft as it is.", json!({ "draft_id": s("Draft id") }), &["draft_id"]),
        tool("delete_draft", "Delete a draft for good.", json!({ "draft_id": s("Draft id") }), &["draft_id"]),
        tool(
            "modify",
            "Change labels on messages, or on whole conversations with threads: true: move_to a label (like moving to a folder), archive, mark read or unread, star or unstar, add or remove labels by name or id. Up to 1000 ids at once.",
            label_props(json!({ "ids": list("Message ids (thread ids with threads: true)"), "threads": flag("The ids are conversations") })),
            &["ids"],
        ),
        tool(
            "trash",
            "Move messages, or whole conversations with threads: true, to the trash; undo: true takes them back out. Gmail empties the trash after 30 days.",
            json!({ "ids": list("Message ids (thread ids with threads: true)"), "threads": flag("The ids are conversations"), "undo": flag("Take them out of the trash") }),
            &["ids"],
        ),
        tool(
            "list_labels",
            "The user's labels and Gmail's system labels with their ids, and the signed-in address. counts: true adds how many messages each has and how many are unread.",
            json!({ "counts": flag("Also count messages per label (slower)") }),
            &[],
        ),
        tool(
            "edit_label",
            "Create, rename or delete one of the user's labels. Nested labels use a slash: \"Clients/Acme\". Deleting a label keeps its messages.",
            json!({
                "action": { "type": "string", "enum": ["create", "rename", "delete"], "description": "What to do" },
                "label": s("The label's name (or id, to rename or delete)"),
                "new_name": s("For rename: the new name"),
            }),
            &["action", "label"],
        ),
        tool(
            "filters",
            "Gmail filters, which sort incoming mail: list them, create one (criteria from, to, subject, query, has_attachment; actions move_to, add_labels, remove_labels, archive, read, starred, forward) or delete one by id.",
            label_props(json!({
                "action": { "type": "string", "enum": ["list", "create", "delete"], "description": "What to do" },
                "id": s("For delete: the filter's id"),
                "from": s("Criteria: sender"),
                "to": s("Criteria: recipient"),
                "subject": s("Criteria: words in the subject"),
                "query": s("Criteria: a Gmail search query"),
                "has_attachment": flag("Criteria: only mail with attachments"),
                "forward": s("Action: forward to this address (it must be a verified forwarding address in Gmail)"),
            })),
            &["action"],
        ),
    ];
    // Every tool works in one of the connected accounts.
    for t in &mut v {
        let all = if t["name"] == "search" { "; \"all\" searches every account" } else { "" };
        t["inputSchema"]["properties"]["account"] = s(&format!("Gmail account to use, by address (default: the default account; see accounts){all}"));
    }
    v.push(tool("accounts", "The Gmail accounts connected in Harbor, the default (what tools use without account) first.", json!({}), &[]));
    v
}

/// The account the tool call at hand works in (tools run one at a time; their threads read it).
static ACCOUNT: Mutex<String> = Mutex::new(String::new());

fn current() -> String {
    ACCOUNT.lock().unwrap().clone()
}

fn use_account(e: &str) {
    *ACCOUNT.lock().unwrap() = e.to_string();
}

const SIGN_IN: &str = "Gmail isn't signed in. The user can sign in under Settings › Integrations › Apps in Harbor (desktop) or Settings › Apps (phone).";

/// The account a call asked for (an address in any case; empty: the default, `accounts[0]`).
fn resolve(asked: &str, accounts: &[String]) -> Result<String, String> {
    let Some(first) = accounts.first() else { return Err(SIGN_IN.into()) };
    let asked = asked.trim();
    if asked.is_empty() {
        return Ok(first.clone());
    }
    accounts
        .iter()
        .find(|e| e.eq_ignore_ascii_case(asked))
        .cloned()
        .ok_or_else(|| format!("No Gmail account {asked} is connected. Connected: {}. Leave account out for the default ({first}).", accounts.join(", ")))
}

fn list_accounts(accounts: &[String]) -> Result<String, String> {
    let Some(first) = accounts.first() else { return Err(SIGN_IN.into()) };
    let mut out = format!("{} Gmail account{} connected; tools use {first} unless you pass account:\n", accounts.len(), if accounts.len() == 1 { "" } else { "s" });
    for (i, e) in accounts.iter().enumerate() {
        out += &format!("- {e}{}\n", if i == 0 { " (default)" } else { "" });
    }
    Ok(out)
}

fn call_tool(name: &str, a: &Value) -> Result<String, String> {
    let accounts = crate::mcp::google_accounts(NAME);
    if name == "accounts" {
        return list_accounts(&accounts);
    }
    if name == "search" && opt(a, "account").eq_ignore_ascii_case("all") {
        return search_all(a, &accounts);
    }
    use_account(&resolve(opt(a, "account"), &accounts)?);
    match name {
        "search" => search(a),
        "get_message" => get_message(a),
        "get_thread" => get_thread(a),
        "get_attachment" => get_attachment(a),
        "send" => send(a),
        "save_draft" => save_draft(a),
        "list_drafts" => list_drafts(a),
        "send_draft" => {
            let v = call("POST", "/drafts/send", Some(&json!({ "id": need(a, "draft_id")? })))?;
            Ok(format!("Sent the draft (message {}, thread {}).", v["id"].as_str().unwrap_or("?"), v["threadId"].as_str().unwrap_or("?")))
        }
        "delete_draft" => {
            let id = need(a, "draft_id")?;
            call("DELETE", &format!("/drafts/{}", enc(id)), None)?;
            Ok(format!("Deleted draft {id}."))
        }
        "modify" => modify(a),
        "trash" => trash(a),
        "list_labels" => list_labels(a),
        "edit_label" => edit_label(a),
        "filters" => filters(a),
        _ => Err(format!("No tool {name}.")),
    }
}

// ------------------------------------------------------------------ Gmail API

fn enc(s: &str) -> String {
    crate::mcp::enc(s)
}

/// One call to the Gmail API (`path` after `/users/me`), with a JSON body.
fn call(method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let body = body.map(|b| b.to_string().into_bytes());
    request(method, &format!("{API}{path}"), body.as_deref().map(|b| ("application/json", b)))
}

/// One HTTPS request through curl: the token comes from a 0600 header file, the body over
/// stdin, so neither is on a command line. A refused token is refreshed once.
fn request(method: &str, url: &str, body: Option<(&str, &[u8])>) -> Result<Value, String> {
    let mut failed: Option<String> = None;
    loop {
        let (hdr, tok) = auth_header(failed.as_deref())?;
        let (code, v) = curl(&hdr, method, url, body)?;
        if code == 401 && failed.is_none() {
            failed = Some(tok);
            continue;
        }
        if (200..300).contains(&code) {
            return Ok(v);
        }
        let msg = v["error"]["message"].as_str().or(v["error_description"].as_str()).or(v["error"].as_str()).unwrap_or("");
        return Err(match code {
            401 => format!("Gmail refused the sign-in of {} ({msg}). Sign in to it again in Harbor (Settings › Integrations › Apps).", current()),
            _ => format!("Gmail: {msg} ({code})"),
        });
    }
}

/// curl with the Authorization header from the file `hdr`: (HTTP status, JSON body).
fn curl(hdr: &std::path::Path, method: &str, url: &str, body: Option<(&str, &[u8])>) -> Result<(u16, Value), String> {
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "-m", "300", "-X", method, "-H"]).arg(format!("@{}", hdr.display()));
    cmd.args(["-H", "Accept: application/json", "-w", "\n%{http_code}"]);
    match body {
        Some((t, _)) => cmd.args(["-H", &format!("Content-Type: {t}"), "--data-binary", "@-"]),
        // Google answers a POST without a length with 411.
        None if method != "GET" && method != "DELETE" => cmd.args(["-H", "Content-Length: 0"]),
        None => &mut cmd,
    };
    cmd.arg(url).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut c = cmd.spawn().map_err(|e| format!("curl: {e}"))?;
    let sin = c.stdin.take();
    let data = body.map(|(_, b)| b.to_vec()).unwrap_or_default();
    let writer = std::thread::spawn(move || {
        if let Some(mut sin) = sin {
            let _ = sin.write_all(&data);
        }
    });
    let out = c.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();
    let text = &out.stdout;
    let cut = text.iter().rposition(|b| *b == b'\n').unwrap_or(0);
    let code: u16 = String::from_utf8_lossy(&text[(cut + 1).min(text.len())..]).trim().parse().unwrap_or(0);
    if code == 0 {
        return Err(format!("Gmail didn't answer: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok((code, serde_json::from_slice(&text[..cut]).unwrap_or(Value::Null)))
}

/// The header file for curl, with a fresh token; `failed` is a token Gmail just refused, so
/// it is refreshed (once, also when several requests at a time were refused).
fn auth_header(failed: Option<&str>) -> Result<(PathBuf, String), String> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    let account = current();
    let gone = || format!("The sign-in of {account} has expired or was revoked. Sign in to it again in Harbor (Settings › Integrations › Apps).");
    let mut tok = crate::mcp::fresh_token_for(NAME, &account, false).ok_or_else(gone)?;
    if failed == Some(tok.as_str()) {
        tok = crate::mcp::fresh_token_for(NAME, &account, true).ok_or_else(gone)?;
    }
    let key: String = account.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || "@._-".contains(c) { c } else { '_' }).collect();
    let p = crate::mcp::private_dir(crate::mcp::dir().join("run")).join(format!("gmail.{key}.hdr"));
    let line = format!("Authorization: Bearer {tok}\n");
    if std::fs::read_to_string(&p).ok().as_deref() != Some(line.as_str()) {
        crate::mcp::write_private(&p, &line).map_err(|e| e.to_string())?;
    }
    Ok((p, tok))
}

/// `f` over `items`, a few at a time; results in order.
fn each<T: Sync>(items: &[T], f: impl Fn(&T) -> Result<Value, String> + Sync) -> Vec<Result<Value, String>> {
    let slots: Vec<Mutex<Option<Result<Value, String>>>> = items.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    std::thread::scope(|sc| {
        for _ in 0..items.len().min(PARALLEL) {
            sc.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(x) = items.get(i) else { break };
                    *slots[i].lock().unwrap() = Some(f(x));
                }
            });
        }
    });
    slots.into_iter().map(|m| m.into_inner().unwrap().unwrap_or_else(|| Err("not fetched".into()))).collect()
}

/// The address a new sign-in's token belongs to (Gmail's profile), before it is saved: the
/// sign-in also learns from it whether the Cloud project has the Gmail API enabled.
pub fn profile_email(token: &str) -> Result<String, String> {
    let name = format!("gmail-signin-{}.hdr", crate::store::random_hex(8).map_err(|e| e.to_string())?);
    let p = crate::mcp::private_dir(crate::mcp::dir().join("run")).join(name);
    crate::mcp::write_private(&p, &format!("Authorization: Bearer {token}\n")).map_err(|e| e.to_string())?;
    let r = curl(&p, "GET", &format!("{API}/profile"), None);
    let _ = std::fs::remove_file(&p);
    let (code, v) = r?;
    if !(200..300).contains(&code) {
        return Err(format!("Gmail: {} ({code})", v["error"]["message"].as_str().unwrap_or("")));
    }
    v["emailAddress"].as_str().map(String::from).ok_or_else(|| "Gmail sent no address.".into())
}

/// The account at hand's address, lowercase.
fn me() -> String {
    current().to_lowercase()
}

type Labels = Vec<(String, String)>;

static LABELS: LazyLock<Mutex<HashMap<String, (Instant, Labels)>>> = LazyLock::new(Default::default);

/// The account's labels: (id, name). Cached for a minute.
fn labels() -> Labels {
    let account = current();
    let mut c = LABELS.lock().unwrap();
    if let Some((at, l)) = c.get(&account) {
        if at.elapsed() < Duration::from_secs(60) {
            return l.clone();
        }
    }
    let Ok(v) = call("GET", "/labels", None) else { return vec![] };
    let l: Vec<(String, String)> = v["labels"].as_array().into_iter().flatten().filter_map(|x| Some((x["id"].as_str()?.to_string(), x["name"].as_str()?.to_string()))).collect();
    c.insert(account, (Instant::now(), l.clone()));
    l
}

/// After a label changed: the next [`labels`] fetches them again.
fn forget_labels() {
    LABELS.lock().unwrap().remove(&current());
}

// ------------------------------------------------------------------ arguments

fn need<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a[k].as_str().map(str::trim).filter(|v| !v.is_empty()).ok_or_else(|| format!("Pass {k}."))
}

fn opt<'a>(a: &'a Value, k: &str) -> &'a str {
    a[k].as_str().map(str::trim).unwrap_or("")
}

/// A list argument: an array, or one comma-separated string.
fn strs(a: &Value, k: &str) -> Vec<String> {
    match &a[k] {
        Value::Array(v) => v.iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        Value::String(x) => x.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        _ => vec![],
    }
}

/// Recipients: a string, or an array joined.
fn addrs(a: &Value, k: &str) -> String {
    match &a[k] {
        Value::Array(v) => v.iter().filter_map(|x| x.as_str()).map(str::trim).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", "),
        Value::String(x) => x.trim().to_string(),
        _ => String::new(),
    }
}

fn max_chars(a: &Value, default: usize) -> usize {
    a["max_chars"].as_u64().map(|n| n as usize).unwrap_or(default).max(200)
}

// ------------------------------------------------------------------ reading

/// A header of a message part, by name in any case.
fn header<'a>(part: &'a Value, name: &str) -> Option<&'a str> {
    part["headers"].as_array()?.iter().find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))?["value"].as_str()
}

fn label_names(ids: &Value, labels: &[(String, String)]) -> String {
    ids.as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| i.as_str())
        .map(|i| labels.iter().find(|(id, _)| id == i).map(|(_, n)| n.as_str()).unwrap_or(i))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `search` in every connected account, one section each.
fn search_all(a: &Value, accounts: &[String]) -> Result<String, String> {
    if accounts.is_empty() {
        return Err(SIGN_IN.into());
    }
    let mut out = String::new();
    for e in accounts {
        use_account(e);
        out += &format!("## {e}\n{}\n", search(a).unwrap_or_else(|err| err));
    }
    Ok(out)
}

fn search(a: &Value) -> Result<String, String> {
    let q = opt(a, "query");
    let max = a["max_results"].as_u64().unwrap_or(20).clamp(1, 100);
    let threads = a["threads"].as_bool() == Some(true);
    let kind = if threads { "threads" } else { "messages" };
    let mut path = format!("/{kind}?maxResults={max}&q={}", enc(q));
    if !opt(a, "page_token").is_empty() {
        path += &format!("&pageToken={}", enc(opt(a, "page_token")));
    }
    if a["include_spam_trash"].as_bool() == Some(true) {
        path += "&includeSpamTrash=true";
    }
    let list = call("GET", &path, None)?;
    let ids: Vec<String> = list[kind].as_array().into_iter().flatten().filter_map(|x| x["id"].as_str().map(String::from)).collect();
    if ids.is_empty() {
        return Ok(format!("No {kind} match {q:?}."));
    }
    let meta = "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
    let items = each(&ids, |id| call("GET", &format!("/{kind}/{id}?{meta}"), None));
    let labels = labels();
    let mut out = format!("{} {kind}{}:\n", ids.len(), if q.is_empty() { String::new() } else { format!(" for {q:?}") });
    for (id, r) in ids.iter().zip(items) {
        match r {
            Ok(v) if threads => out += &thread_line(&v, &labels),
            Ok(v) => out += &message_line(&v, &labels),
            Err(e) => out += &format!("- {id}: {e}\n"),
        }
    }
    if let Some(t) = list["nextPageToken"].as_str() {
        out += &format!("More: page_token {t}\n");
    }
    Ok(out)
}

fn message_line(v: &Value, labels: &[(String, String)]) -> String {
    let p = &v["payload"];
    format!(
        "- {} (thread {}) {}\n  {}: {} [{}]\n  {}\n",
        v["id"].as_str().unwrap_or("?"),
        v["threadId"].as_str().unwrap_or("?"),
        header(p, "Date").unwrap_or(""),
        header(p, "From").unwrap_or("?"),
        header(p, "Subject").unwrap_or("(no subject)"),
        label_names(&v["labelIds"], labels),
        entities(v["snippet"].as_str().unwrap_or("")),
    )
}

fn thread_line(v: &Value, labels: &[(String, String)]) -> String {
    let msgs = v["messages"].as_array().cloned().unwrap_or_default();
    let (Some(first), Some(last)) = (msgs.first(), msgs.last()) else {
        return format!("- thread {}: empty\n", v["id"].as_str().unwrap_or("?"));
    };
    let mut ids: Vec<Value> = vec![];
    for m in &msgs {
        for l in m["labelIds"].as_array().into_iter().flatten() {
            if !ids.contains(l) {
                ids.push(l.clone());
            }
        }
    }
    format!(
        "- thread {}, {} message{}, last {}\n  {}: {} [{}]\n  {}\n",
        v["id"].as_str().unwrap_or("?"),
        msgs.len(),
        if msgs.len() == 1 { "" } else { "s" },
        header(&last["payload"], "Date").unwrap_or(""),
        header(&last["payload"], "From").unwrap_or("?"),
        header(&first["payload"], "Subject").unwrap_or("(no subject)"),
        label_names(&Value::Array(ids), labels),
        entities(last["snippet"].as_str().unwrap_or("")),
    )
}

fn get_message(a: &Value) -> Result<String, String> {
    let v = call("GET", &format!("/messages/{}?format=full", enc(need(a, "id")?)), None)?;
    Ok(show_message(&v, &labels(), max_chars(a, 20_000)))
}

fn get_thread(a: &Value) -> Result<String, String> {
    let v = call("GET", &format!("/threads/{}?format=full", enc(need(a, "id")?)), None)?;
    let labels = labels();
    let msgs = v["messages"].as_array().cloned().unwrap_or_default();
    let max = max_chars(a, 8_000);
    let shown: Vec<String> = msgs.iter().map(|m| show_message(m, &labels, max)).collect();
    Ok(format!("Thread {}: {} message{}\n\n{}", v["id"].as_str().unwrap_or("?"), msgs.len(), if msgs.len() == 1 { "" } else { "s" }, shown.join("\n---\n\n")))
}

/// A message as text: headers, labels, attachments, body.
fn show_message(v: &Value, labels: &[(String, String)], max: usize) -> String {
    let p = &v["payload"];
    let mut s = format!("Message {} (thread {}) [{}]\n", v["id"].as_str().unwrap_or("?"), v["threadId"].as_str().unwrap_or("?"), label_names(&v["labelIds"], labels));
    for h in ["From", "Reply-To", "To", "Cc", "Date", "Subject"] {
        if let Some(x) = header(p, h) {
            s += &format!("{h}: {x}\n");
        }
    }
    let mut parts = Parts::default();
    walk(p, &mut parts);
    if !parts.files.is_empty() {
        s += "Attachments:\n";
        for f in &parts.files {
            s += &format!("- {} ({}, {}) attachment_id: {}\n", f.name, f.mime, size(f.size), if f.id.is_empty() { "(inline, none)" } else { &f.id });
        }
    }
    s += "\n";
    s += &clip(&parts.text(), max);
    s.push('\n');
    s
}

#[derive(Default)]
struct Parts {
    text: Vec<String>,
    html: Vec<String>,
    files: Vec<File>,
}

struct File {
    name: String,
    mime: String,
    size: u64,
    id: String,
}

impl Parts {
    /// The plain-text parts, or the HTML ones as text when there are none.
    fn text(&self) -> String {
        let t = if self.text.iter().any(|t| !t.trim().is_empty()) { self.text.join("\n\n") } else { html_text(&self.html.join("\n")) };
        tidy(&t)
    }
}

/// Collects a Gmail payload's (format=full) text, HTML and attachments.
fn walk(p: &Value, out: &mut Parts) {
    if let Some(parts) = p["parts"].as_array() {
        for q in parts {
            walk(q, out);
        }
        return;
    }
    let mime = p["mimeType"].as_str().unwrap_or("").to_ascii_lowercase();
    let name = p["filename"].as_str().unwrap_or("");
    let body = &p["body"];
    let disposition = header(p, "Content-Disposition").unwrap_or("").trim_start().to_ascii_lowercase();
    if !name.is_empty() || disposition.starts_with("attachment") || !(mime == "text/plain" || mime == "text/html") {
        let id = body["attachmentId"].as_str().unwrap_or("").to_string();
        let size = body["size"].as_u64().unwrap_or(0);
        if !id.is_empty() || size > 0 {
            out.files.push(File { name: if name.is_empty() { "(unnamed)".into() } else { name.into() }, mime, size, id });
        }
        return;
    }
    let data = unb64(body["data"].as_str().unwrap_or(""));
    let text = decode_charset(&data, &charset(header(p, "Content-Type").unwrap_or("")));
    if mime == "text/html" { out.html.push(text) } else { out.text.push(text) }
}

/// `charset=` of a Content-Type, lowercased ("utf-8" when none).
fn charset(ctype: &str) -> String {
    ctype
        .split(';')
        .filter_map(|p| p.trim().split_once('='))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("charset"))
        .map(|(_, v)| v.trim().trim_matches('"').to_ascii_lowercase())
        .unwrap_or_else(|| "utf-8".into())
}

/// Bytes in a part's charset: UTF-8, or Latin-1 / Windows-1252 byte for byte.
fn decode_charset(data: &[u8], cs: &str) -> String {
    match cs {
        "iso-8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" | "iso-8859-15" => data.iter().map(|b| *b as char).collect(),
        _ => String::from_utf8_lossy(data).into_owned(),
    }
}

/// HTML as readable text: blocks become lines, links keep their address, scripts and
/// styles go.
fn html_text(h: &str) -> String {
    let mut out = String::new();
    let mut rest = h;
    let mut link: Option<(String, usize)> = None;
    let push_text = |out: &mut String, t: &str| out.push_str(&t.replace(['\r', '\n', '\t'], " "));
    while let Some(lt) = rest.find('<') {
        push_text(&mut out, &rest[..lt]);
        let after = &rest[lt + 1..];
        if let Some(c) = after.strip_prefix("!--") {
            rest = c.find("-->").map(|e| &c[e + 3..]).unwrap_or("");
            continue;
        }
        let Some(gt) = after.find('>') else {
            rest = "";
            break;
        };
        let tag = &after[..gt];
        rest = &after[gt + 1..];
        let lower = tag.to_ascii_lowercase();
        let closing = lower.starts_with('/');
        let name = lower.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_string();
        match name.as_str() {
            "script" | "style" | "head" | "title" if !closing => {
                rest = rest.to_ascii_lowercase().find(&format!("</{name}")).map(|e| &rest[e..]).unwrap_or("");
            }
            "br" => out.push('\n'),
            "p" | "div" | "tr" | "table" | "ul" | "ol" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "section" | "article" | "header" | "footer" | "hr" => {
                out.push('\n')
            }
            "li" if !closing => out.push_str("\n- "),
            "td" | "th" if closing => out.push(' '),
            "a" if !closing => link = attr(tag, "href").map(|u| (u, out.len())),
            "a" => {
                if let Some((u, at)) = link.take() {
                    let shown = out.get(at..).unwrap_or("").trim().to_string();
                    if !u.is_empty() && !u.starts_with('#') && !u.starts_with("mailto:") && shown != u {
                        out += &format!(" ({u})");
                    }
                }
            }
            _ => {}
        }
    }
    push_text(&mut out, rest);
    entities(&out)
}

/// An attribute's value in a tag's text.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name).map(|i| i + from) {
        from = i + name.len();
        let before_ok = i == 0 || lower.as_bytes()[i - 1].is_ascii_whitespace();
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=').filter(|_| before_ok) else { continue };
        let rest = rest.trim_start();
        let v = match rest.chars().next() {
            Some(q @ ('"' | '\'')) => rest[1..].split(q).next().unwrap_or(""),
            _ => rest.split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or(""),
        };
        return Some(entities(v));
    }
    None
}

/// HTML character references, the common named ones and numeric ones.
fn entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.char_indices().take(12).find(|(_, c)| *c == ';').map(|(j, _)| j);
        let decoded = end.and_then(|e| {
            let name = &rest[1..e];
            let c = match name {
                "amp" => "&".to_string(),
                "lt" => "<".into(),
                "gt" => ">".into(),
                "quot" => "\"".into(),
                "apos" => "'".into(),
                "nbsp" => " ".into(),
                "ndash" => "–".into(),
                "mdash" => "—".into(),
                "hellip" => "…".into(),
                "lsquo" => "‘".into(),
                "rsquo" => "’".into(),
                "ldquo" => "“".into(),
                "rdquo" => "”".into(),
                "copy" => "©".into(),
                "reg" => "®".into(),
                "zwnj" | "zwj" | "shy" => String::new(),
                _ => {
                    let n = name.strip_prefix('#')?;
                    let code = match n.strip_prefix(['x', 'X']) {
                        Some(h) => u32::from_str_radix(h, 16).ok()?,
                        None => n.parse().ok()?,
                    };
                    char::from_u32(code).map(String::from)?
                }
            };
            Some((c, e))
        });
        match decoded {
            Some((c, e)) => {
                out += &c;
                rest = &rest[e + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Trims lines, drops invisible padding characters, keeps at most one blank line in a row.
fn tidy(t: &str) -> String {
    let mut out: Vec<String> = vec![];
    for l in t.lines() {
        let l: String = l.chars().filter(|c| !matches!(c, '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{034f}' | '\u{feff}' | '\u{00ad}')).collect();
        let l = l.split([' ', '\u{a0}']).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
        if l.is_empty() && out.last().is_none_or(|p| p.is_empty()) {
            continue;
        }
        out.push(l);
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out.join("\n")
}

fn clip(t: &str, max: usize) -> String {
    let n = t.chars().count();
    if n <= max {
        return t.to_string();
    }
    let cut: String = t.chars().take(max).collect();
    format!("{cut}\n[… {} more characters: pass a larger max_chars to read them]", n - max)
}

fn size(n: u64) -> String {
    match n {
        0..1024 => format!("{n} B"),
        1024..1_048_576 => format!("{} KB", n / 1024),
        _ => format!("{:.1} MB", n as f64 / 1_048_576.0),
    }
}

fn get_attachment(a: &Value) -> Result<String, String> {
    let (mid, aid) = (need(a, "message_id")?, need(a, "attachment_id")?);
    let v = call("GET", &format!("/messages/{}/attachments/{}", enc(mid), enc(aid)), None)?;
    let data = unb64(v["data"].as_str().unwrap_or(""));
    let name = safe_name(opt(a, "filename"));
    let path = match opt(a, "path") {
        "" => {
            let d = std::env::temp_dir().join("harbor-gmail");
            std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
            d.join(&name)
        }
        p => {
            let p = PathBuf::from(p);
            if p.is_dir() { p.join(&name) } else { p }
        }
    };
    std::fs::write(&path, &data).map_err(|e| format!("Can't write {}: {e}", path.display()))?;
    Ok(format!("Saved {} ({}) to {}", name, size(data.len() as u64), path.display()))
}

/// A filename from a message, safe to use in a folder.
fn safe_name(n: &str) -> String {
    let n: String = n.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c }).collect();
    let n = n.trim().trim_start_matches('.').to_string();
    if n.is_empty() { "attachment".into() } else { n }
}

// ------------------------------------------------------------------ writing

/// A message to send or keep as a draft.
#[derive(Default, Debug)]
struct Mail {
    to: String,
    cc: String,
    bcc: String,
    subject: String,
    text: String,
    html: String,
    /// (filename, MIME type, bytes).
    files: Vec<(String, String, Vec<u8>)>,
    in_reply_to: String,
    references: String,
    thread: String,
}

/// The message the arguments describe; with `reply_to`, threaded into that conversation.
fn compose(a: &Value) -> Result<Mail, String> {
    let mut m = Mail { to: addrs(a, "to"), cc: addrs(a, "cc"), bcc: addrs(a, "bcc"), subject: opt(a, "subject").into(), ..Default::default() };
    m.text = a["body"].as_str().unwrap_or("").to_string();
    m.html = a["html"].as_str().unwrap_or("").to_string();
    let reply = opt(a, "reply_to");
    if !reply.is_empty() {
        let hs = ["From", "Reply-To", "To", "Cc", "Subject", "Message-ID", "References"].map(|h| format!("metadataHeaders={h}")).join("&");
        let o = call("GET", &format!("/messages/{}?format=metadata&{hs}", enc(reply)), None)?;
        let p = &o["payload"];
        let h = |k: &str| header(p, k).unwrap_or("").to_string();
        m.thread = o["threadId"].as_str().unwrap_or("").to_string();
        m.in_reply_to = h("Message-ID");
        m.references = [h("References"), h("Message-ID")].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(" ");
        if m.subject.is_empty() {
            m.subject = re_subject(&h("Subject"));
        }
        if m.to.is_empty() {
            let me = me();
            let from = if h("Reply-To").is_empty() { h("From") } else { h("Reply-To") };
            // Answering your own message goes to the people it went to.
            let mine = !me.is_empty() && addr_email(&h("From")) == me;
            m.to = if mine { h("To") } else { from };
            if a["reply_all"].as_bool() == Some(true) {
                let others = if mine { h("Cc") } else { format!("{}, {}", h("To"), h("Cc")) };
                m.cc = reply_all_cc(&me, &m.to, &others, &m.cc);
            }
        }
    }
    for path in strs(a, "attachments") {
        let data = std::fs::read(&path).map_err(|e| format!("Can't attach {path}: {e}"))?;
        let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "attachment".into());
        let mime = mime_for(&name).to_string();
        m.files.push((name, mime, data));
    }
    Ok(m)
}

fn re_subject(s: &str) -> String {
    if s.trim().to_ascii_lowercase().starts_with("re:") { s.trim().to_string() } else { format!("Re: {}", s.trim()) }
}

/// Addresses in a header, split on commas outside quotes and angle brackets.
fn split_addrs(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted, mut angle) = (vec![], String::new(), false, false);
    for c in s.chars() {
        match c {
            '"' => quoted = !quoted,
            '<' if !quoted => angle = true,
            '>' if !quoted => angle = false,
            ',' | ';' if !quoted && !angle => {
                out.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    out.push(cur);
    out.into_iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect()
}

/// "Ana <Ana@Example.com>" → "ana@example.com".
fn addr_email(a: &str) -> String {
    let a = a.trim();
    let e = match (a.rfind('<'), a.rfind('>')) {
        (Some(i), Some(j)) if i < j => &a[i + 1..j],
        _ => a,
    };
    e.trim().to_lowercase()
}

/// Cc for a reply to all: `others` and `cc`, without the user and whoever is in `to`, each once.
fn reply_all_cc(me: &str, to: &str, others: &str, cc: &str) -> String {
    let mut seen: Vec<String> = split_addrs(to).iter().map(|a| addr_email(a)).collect();
    seen.push(me.to_lowercase());
    let mut out = vec![];
    for a in split_addrs(cc).into_iter().chain(split_addrs(others)) {
        let e = addr_email(&a);
        if e.is_empty() || seen.contains(&e) {
            continue;
        }
        seen.push(e);
        out.push(a);
    }
    out.join(", ")
}

fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "ics" => "text/calendar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// A header value on one line: a CR or LF in it would start a header of its own.
fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

/// RFC 2047 encoded words for a header that isn't plain ASCII, folded so no line gets long.
fn encode_words(s: &str) -> String {
    let s = one_line(s);
    if s.is_ascii() {
        return s;
    }
    let mut words = vec![];
    let mut chunk = String::new();
    for c in s.chars() {
        if chunk.len() + c.len_utf8() > 45 {
            words.push(std::mem::take(&mut chunk));
        }
        chunk.push(c);
    }
    words.push(chunk);
    words.iter().map(|w| format!("=?UTF-8?B?{}?=", crate::agent::base64(w.as_bytes()))).collect::<Vec<_>>().join("\r\n ")
}

/// An address header: display names that aren't ASCII become encoded words.
fn encode_addrs(s: &str) -> String {
    split_addrs(&one_line(s))
        .iter()
        .map(|a| match a.rfind('<') {
            Some(i) if !a.is_ascii() => {
                let name = a[..i].trim().trim_matches('"');
                format!("{} {}", encode_words(name), &a[i..])
            }
            _ => a.clone(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Base64 in lines of 76, as MIME wants it.
fn b64_lines(data: &[u8]) -> String {
    let b = crate::agent::base64(data);
    b.as_bytes().chunks(76).map(|l| String::from_utf8_lossy(l).into_owned()).collect::<Vec<_>>().join("\r\n")
}

fn leaf(ctype: &str, extra: &str, data: &[u8]) -> String {
    format!("Content-Type: {ctype}\r\n{extra}Content-Transfer-Encoding: base64\r\n\r\n{}\r\n", b64_lines(data))
}

fn multipart(kind: &str, boundary: &str, parts: &[String]) -> String {
    let body: String = parts.iter().map(|p| format!("--{boundary}\r\n{p}")).collect();
    format!("Content-Type: multipart/{kind}; boundary=\"{boundary}\"\r\n\r\n{body}--{boundary}--\r\n")
}

/// The RFC 2822 message, CRLF line ends. Gmail adds From, Date and Message-ID.
fn build(m: &Mail, boundary: &str) -> String {
    let mut h = String::new();
    for (k, v) in [("To", &m.to), ("Cc", &m.cc), ("Bcc", &m.bcc)] {
        if !v.trim().is_empty() {
            h += &format!("{k}: {}\r\n", encode_addrs(v));
        }
    }
    h += &format!("Subject: {}\r\n", encode_words(&m.subject));
    if !m.in_reply_to.is_empty() {
        h += &format!("In-Reply-To: {}\r\nReferences: {}\r\n", one_line(&m.in_reply_to), one_line(&m.references));
    }
    h += "MIME-Version: 1.0\r\n";
    let text = if m.text.is_empty() && !m.html.is_empty() { tidy(&html_text(&m.html)) } else { m.text.clone() };
    let plain = leaf("text/plain; charset=UTF-8", "", text.as_bytes());
    let body = if m.html.is_empty() { plain } else { multipart("alternative", &format!("{boundary}-alt"), &[plain, leaf("text/html; charset=UTF-8", "", m.html.as_bytes())]) };
    if m.files.is_empty() {
        return h + &body;
    }
    let mut parts = vec![body];
    for (name, mime, data) in &m.files {
        let name = one_line(name).replace('"', "'");
        let disp = if name.is_ascii() {
            format!("Content-Disposition: attachment; filename=\"{name}\"\r\n")
        } else {
            format!("Content-Disposition: attachment; filename*=UTF-8''{}\r\n", enc(&name))
        };
        parts.push(leaf(&format!("{mime}; name=\"{}\"", encode_words(&name)), &disp, data));
    }
    h + &multipart("mixed", &format!("{boundary}-mix"), &parts)
}

fn boundary() -> String {
    format!("harbor-{}", crate::store::random_hex(12).unwrap_or_else(|_| format!("{}", crate::store::now())))
}

/// Sends `raw` to `path` (`/messages/send`, `/drafts`, `/drafts/<id>`): as base64url in JSON,
/// or as a multipart upload when large. `draft` wraps it in a draft resource.
fn put_raw(method: &str, path: &str, raw: &str, thread: &str, draft: Option<&str>) -> Result<Value, String> {
    let mut msg = json!({});
    if !thread.is_empty() {
        msg["threadId"] = json!(thread);
    }
    let wrap = |msg: Value| match draft {
        Some("") => json!({ "message": msg }),
        Some(id) => json!({ "id": id, "message": msg }),
        None => msg,
    };
    if raw.len() <= RAW_MAX {
        msg["raw"] = json!(b64url(raw.as_bytes()));
        return call(method, path, Some(&wrap(msg)));
    }
    let b = boundary();
    let mut body = format!("--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n--{b}\r\nContent-Type: message/rfc822\r\n\r\n", wrap(msg)).into_bytes();
    body.extend_from_slice(raw.as_bytes());
    body.extend_from_slice(format!("\r\n--{b}--\r\n").as_bytes());
    request(method, &format!("{UPLOAD}{path}?uploadType=multipart"), Some((&format!("multipart/related; boundary={b}"), &body)))
}

fn b64url(data: &[u8]) -> String {
    crate::agent::base64(data).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string()
}

/// Base64 or base64url, padded or not; anything else in it is skipped.
fn unb64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for v in s.bytes().filter_map(val) {
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn send(a: &Value) -> Result<String, String> {
    let m = compose(a)?;
    if m.to.is_empty() && m.cc.is_empty() && m.bcc.is_empty() {
        return Err("Who to? Pass to, or reply_to.".into());
    }
    let v = put_raw("POST", "/messages/send", &build(&m, &boundary()), &m.thread, None)?;
    Ok(format!(
        "Sent to {} (message {}, thread {}).",
        [&m.to, &m.cc, &m.bcc].iter().filter(|x| !x.is_empty()).map(|x| x.as_str()).collect::<Vec<_>>().join(", "),
        v["id"].as_str().unwrap_or("?"),
        v["threadId"].as_str().unwrap_or("?")
    ))
}

fn save_draft(a: &Value) -> Result<String, String> {
    let m = compose(a)?;
    let raw = build(&m, &boundary());
    let id = opt(a, "draft_id");
    let v = if id.is_empty() { put_raw("POST", "/drafts", &raw, &m.thread, Some(""))? } else { put_raw("PUT", &format!("/drafts/{}", enc(id)), &raw, &m.thread, Some(id))? };
    Ok(format!(
        "Draft {} saved (message {}, thread {}). It is in Gmail's Drafts.",
        v["id"].as_str().unwrap_or("?"),
        v["message"]["id"].as_str().unwrap_or("?"),
        v["message"]["threadId"].as_str().unwrap_or("?")
    ))
}

fn list_drafts(a: &Value) -> Result<String, String> {
    let max = a["max_results"].as_u64().unwrap_or(20).clamp(1, 100);
    let mut path = format!("/drafts?maxResults={max}");
    if !opt(a, "query").is_empty() {
        path += &format!("&q={}", enc(opt(a, "query")));
    }
    let list = call("GET", &path, None)?;
    let ids: Vec<String> = list["drafts"].as_array().into_iter().flatten().filter_map(|d| d["id"].as_str().map(String::from)).collect();
    if ids.is_empty() {
        return Ok("No drafts.".into());
    }
    let items = each(&ids, |id| call("GET", &format!("/drafts/{}?format=metadata", enc(id)), None));
    let mut out = format!("{} drafts:\n", ids.len());
    for (id, r) in ids.iter().zip(items) {
        match r {
            Ok(v) => {
                let p = &v["message"]["payload"];
                out += &format!(
                    "- {id} (message {}, thread {})\n  To: {} · {}\n  {}\n",
                    v["message"]["id"].as_str().unwrap_or("?"),
                    v["message"]["threadId"].as_str().unwrap_or("?"),
                    header(p, "To").unwrap_or("(nobody yet)"),
                    header(p, "Subject").unwrap_or("(no subject)"),
                    entities(v["message"]["snippet"].as_str().unwrap_or("")),
                )
            }
            Err(e) => out += &format!("- {id}: {e}\n"),
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ labels

/// A label's id from its name or id, in any case; system labels also when the list is empty.
fn label_id(n: &str, labels: &[(String, String)]) -> Result<String, String> {
    let n = n.trim();
    if let Some((id, _)) = labels.iter().find(|(id, _)| id == n) {
        return Ok(id.clone());
    }
    if let Some((id, _)) = labels.iter().find(|(id, name)| name.eq_ignore_ascii_case(n) || id.eq_ignore_ascii_case(n)) {
        return Ok(id.clone());
    }
    let up = n.to_ascii_uppercase();
    if SYSTEM.contains(&up.as_str()) || up.starts_with("CATEGORY_") {
        return Ok(up);
    }
    Err(format!("No label {n:?}. See list_labels, or create it with edit_label."))
}

/// (labels to add, labels to remove) for `move_to`, `add_labels`, `remove_labels`,
/// `archive`, `read` and `starred`.
fn plan(a: &Value, labels: &[(String, String)]) -> Result<(Vec<String>, Vec<String>), String> {
    let (mut add, mut rm) = (vec![], vec![]);
    for n in strs(a, "add_labels") {
        add.push(label_id(&n, labels)?);
    }
    for n in strs(a, "remove_labels") {
        rm.push(label_id(&n, labels)?);
    }
    let to = opt(a, "move_to");
    if !to.is_empty() {
        let id = label_id(to, labels)?;
        match id.as_str() {
            "TRASH" => return Err("To move mail to the trash, use trash.".into()),
            "INBOX" => {}
            _ => rm.push("INBOX".into()),
        }
        add.push(id);
    }
    if a["archive"].as_bool() == Some(true) {
        rm.push("INBOX".into());
    }
    match a["read"].as_bool() {
        Some(true) => rm.push("UNREAD".into()),
        Some(false) => add.push("UNREAD".into()),
        None => {}
    }
    match a["starred"].as_bool() {
        Some(true) => add.push("STARRED".into()),
        Some(false) => rm.push("STARRED".into()),
        None => {}
    }
    let dedup = |v: &mut Vec<String>| {
        let mut seen = vec![];
        v.retain(|x| {
            let new = !seen.contains(x);
            seen.push(x.clone());
            new
        });
    };
    dedup(&mut add);
    dedup(&mut rm);
    if let Some(x) = add.iter().find(|x| rm.contains(x)) {
        return Err(format!("{} would be both added and removed.", label_names(&json!([x]), labels)));
    }
    Ok((add, rm))
}

/// "+Work, -INBOX".
fn describe(add: &[String], rm: &[String], labels: &[(String, String)]) -> String {
    let name = |i: &String| label_names(&json!([i]), labels);
    add.iter().map(|i| format!("+{}", name(i))).chain(rm.iter().map(|i| format!("-{}", name(i)))).collect::<Vec<_>>().join(", ")
}

fn modify(a: &Value) -> Result<String, String> {
    let ids = strs(a, "ids");
    if ids.is_empty() {
        return Err("Pass ids.".into());
    }
    let labels = labels();
    let (add, rm) = plan(a, &labels)?;
    if add.is_empty() && rm.is_empty() {
        return Err("Nothing to change: pass move_to, archive, read, starred, add_labels or remove_labels.".into());
    }
    let change = json!({ "addLabelIds": add, "removeLabelIds": rm });
    if a["threads"].as_bool() == Some(true) {
        let r = each(&ids, |id| call("POST", &format!("/threads/{}/modify", enc(id)), Some(&change)));
        let failed: Vec<String> = ids.iter().zip(&r).filter_map(|(id, r)| r.as_ref().err().map(|e| format!("{id}: {e}"))).collect();
        let done = ids.len() - failed.len();
        let mut out = format!("{done} conversation{} updated: {}.", if done == 1 { "" } else { "s" }, describe(&add, &rm, &labels));
        if !failed.is_empty() {
            out += &format!("\nFailed:\n{}", failed.join("\n"));
        }
        return Ok(out);
    }
    for chunk in ids.chunks(1000) {
        let mut body = change.clone();
        body["ids"] = json!(chunk);
        call("POST", "/messages/batchModify", Some(&body))?;
    }
    Ok(format!("{} message{} updated: {}.", ids.len(), if ids.len() == 1 { "" } else { "s" }, describe(&add, &rm, &labels)))
}

fn trash(a: &Value) -> Result<String, String> {
    let ids = strs(a, "ids");
    if ids.is_empty() {
        return Err("Pass ids.".into());
    }
    let kind = if a["threads"].as_bool() == Some(true) { "threads" } else { "messages" };
    let verb = if a["undo"].as_bool() == Some(true) { "untrash" } else { "trash" };
    let r = each(&ids, |id| call("POST", &format!("/{kind}/{}/{verb}", enc(id)), None));
    let failed: Vec<String> = ids.iter().zip(&r).filter_map(|(id, r)| r.as_ref().err().map(|e| format!("{id}: {e}"))).collect();
    let done = ids.len() - failed.len();
    let mut out = format!("{done} {kind} {}.", if verb == "trash" { "moved to the trash" } else { "taken out of the trash" });
    if !failed.is_empty() {
        out += &format!("\nFailed:\n{}", failed.join("\n"));
    }
    Ok(out)
}

fn list_labels(a: &Value) -> Result<String, String> {
    let v = call("GET", "/labels", None)?;
    let mut all: Vec<Value> = v["labels"].as_array().cloned().unwrap_or_default();
    all.sort_by_key(|l| (l["type"] != "user", l["name"].as_str().unwrap_or("").to_lowercase()));
    let counts = if a["counts"].as_bool() == Some(true) {
        let ids: Vec<String> = all.iter().filter_map(|l| l["id"].as_str().map(String::from)).collect();
        each(&ids, |id| call("GET", &format!("/labels/{}", enc(id)), None)).into_iter().map(Result::ok).collect()
    } else {
        vec![None; all.len()]
    };
    let mut out = format!("Signed in as {}.\n", me());
    let mut system = false;
    out += "Your labels:\n";
    for (l, c) in all.iter().zip(counts) {
        if l["type"] != "user" && !system {
            system = true;
            out += "System labels:\n";
        }
        let n = c.map(|c| format!(": {} messages, {} unread", c["messagesTotal"].as_u64().unwrap_or(0), c["messagesUnread"].as_u64().unwrap_or(0))).unwrap_or_default();
        out += &format!("- {} (id {}){n}\n", l["name"].as_str().unwrap_or("?"), l["id"].as_str().unwrap_or("?"));
    }
    Ok(out)
}

fn edit_label(a: &Value) -> Result<String, String> {
    let label = need(a, "label")?;
    let r = match need(a, "action")? {
        "create" => {
            let v = call("POST", "/labels", Some(&json!({ "name": label, "labelListVisibility": "labelShow", "messageListVisibility": "show" })))?;
            format!("Created label {label} (id {}).", v["id"].as_str().unwrap_or("?"))
        }
        "rename" => {
            let new = need(a, "new_name")?;
            let id = label_id(label, &labels())?;
            call("PATCH", &format!("/labels/{}", enc(&id)), Some(&json!({ "name": new })))?;
            format!("Renamed {label} to {new}.")
        }
        "delete" => {
            let id = label_id(label, &labels())?;
            call("DELETE", &format!("/labels/{}", enc(&id)), None)?;
            format!("Deleted label {label}; its messages stay.")
        }
        x => return Err(format!("No action {x:?}: create, rename or delete.")),
    };
    forget_labels();
    Ok(r)
}

fn filters(a: &Value) -> Result<String, String> {
    match need(a, "action")? {
        "list" => {
            let v = call("GET", "/settings/filters", None)?;
            let labels = labels();
            let fs = v["filter"].as_array().cloned().unwrap_or_default();
            if fs.is_empty() {
                return Ok("No filters.".into());
            }
            let mut out = format!("{} filters:\n", fs.len());
            for f in &fs {
                let c = &f["criteria"];
                let mut crit = vec![];
                for (k, label) in [("from", "from:"), ("to", "to:"), ("subject", "subject:"), ("query", ""), ("negatedQuery", "not ")] {
                    if let Some(x) = c[k].as_str() {
                        crit.push(format!("{label}{x}"));
                    }
                }
                if c["hasAttachment"] == true {
                    crit.push("has:attachment".into());
                }
                let act = &f["action"];
                let ids = |k: &str| act[k].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>();
                let mut does = describe(&ids("addLabelIds"), &ids("removeLabelIds"), &labels);
                if let Some(fw) = act["forward"].as_str() {
                    does = [does, format!("forward to {fw}")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", ");
                }
                out += &format!("- {}: {} → {}\n", f["id"].as_str().unwrap_or("?"), crit.join(" "), does);
            }
            Ok(out)
        }
        "create" => {
            let mut criteria = json!({});
            for (k, key) in [("from", "from"), ("to", "to"), ("subject", "subject"), ("query", "query")] {
                if !opt(a, k).is_empty() {
                    criteria[key] = json!(opt(a, k));
                }
            }
            if a["has_attachment"].as_bool() == Some(true) {
                criteria["hasAttachment"] = json!(true);
            }
            if criteria.as_object().is_some_and(|c| c.is_empty()) {
                return Err("Pass at least one criterion: from, to, subject, query or has_attachment.".into());
            }
            let labels = labels();
            let (add, rm) = plan(a, &labels)?;
            let mut action = json!({});
            if !add.is_empty() {
                action["addLabelIds"] = json!(add);
            }
            if !rm.is_empty() {
                action["removeLabelIds"] = json!(rm);
            }
            if !opt(a, "forward").is_empty() {
                action["forward"] = json!(opt(a, "forward"));
            }
            if action.as_object().is_some_and(|c| c.is_empty()) {
                return Err("Pass what it does: move_to, add_labels, remove_labels, archive, read, starred or forward.".into());
            }
            let v = call("POST", "/settings/filters", Some(&json!({ "criteria": criteria, "action": action })))?;
            Ok(format!("Created filter {}.", v["id"].as_str().unwrap_or("?")))
        }
        "delete" => {
            let id = need(a, "id")?;
            call("DELETE", &format!("/settings/filters/{}", enc(id)), None)?;
            Ok(format!("Deleted filter {id}."))
        }
        x => Err(format!("No action {x:?}: list, create or delete.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lbl() -> Labels {
        [("INBOX", "INBOX"), ("UNREAD", "UNREAD"), ("STARRED", "STARRED"), ("Label_1", "Work"), ("Label_2", "Clients/Acme")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn base64url_both_ways() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foob", b"\xff\xfe\xfd\x00binary?>", "Olá, ação ✓".as_bytes()] {
            assert_eq!(unb64(&b64url(data)), data);
            assert_eq!(unb64(&crate::agent::base64(data)), data);
        }
        assert!(!b64url(b"\xfb\xff\xbf").contains(['+', '/', '=']));
        assert_eq!(unb64("SGVsbG8sIHdvcmxk\r\nIQ=="), b"Hello, world!");
        assert_eq!(unb64("_-8"), vec![0xff, 0xef]);
    }

    /// The part of `raw` after the blank line that ends its headers.
    fn body_of(part: &str) -> &str {
        part.split_once("\r\n\r\n").map(|x| x.1).unwrap_or("")
    }

    #[test]
    fn builds_a_plain_message() {
        let m = Mail { to: "Ana <ana@example.com>, bo@example.com".into(), subject: "Hi\r\nBcc: evil@example.com".into(), text: "Hello\nthere".into(), ..Default::default() };
        let raw = build(&m, "B");
        let (head, _) = raw.split_once("\r\n\r\n").unwrap();
        assert!(head.contains("To: Ana <ana@example.com>, bo@example.com\r\n"));
        // A line break in a value can't start a header of its own.
        assert!(head.contains("Subject: Hi  Bcc: evil@example.com\r\n"));
        assert!(!head.contains("\r\nBcc:"));
        assert!(head.contains("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64"));
        assert_eq!(unb64(body_of(&raw)), b"Hello\nthere");
        assert!(!raw.contains("In-Reply-To"));
    }

    #[test]
    fn builds_html_attachments_and_reply_headers() {
        let m = Mail {
            to: "Zoë Müller <z@example.com>".into(),
            subject: "Relatório de ação".into(),
            html: "<p>Olá <b>mundo</b></p>".into(),
            files: vec![("relatório.pdf".into(), "application/pdf".into(), vec![0, 1, 2, 255]), ("a.txt".into(), "text/plain".into(), b"x".to_vec())],
            in_reply_to: "<m1@example.com>".into(),
            references: "<m0@example.com> <m1@example.com>".into(),
            ..Default::default()
        };
        let raw = build(&m, "B");
        assert!(raw.contains("In-Reply-To: <m1@example.com>\r\nReferences: <m0@example.com> <m1@example.com>\r\n"));
        assert!(raw.contains(&format!("Subject: =?UTF-8?B?{}?=\r\n", crate::agent::base64("Relatório de ação".as_bytes()))));
        assert!(raw.contains(&format!("To: =?UTF-8?B?{}?= <z@example.com>\r\n", crate::agent::base64("Zoë Müller".as_bytes()))));
        assert!(raw.contains("Content-Type: multipart/mixed; boundary=\"B-mix\"\r\n"));
        assert!(raw.contains("Content-Type: multipart/alternative; boundary=\"B-alt\"\r\n"));
        assert!(raw.ends_with("--B-mix--\r\n"));
        let parts: Vec<&str> = raw.split("--B-alt\r\n").skip(1).collect();
        assert_eq!(parts.len(), 2);
        // The plain alternative is the HTML as text.
        assert_eq!(String::from_utf8(unb64(body_of(parts[0]))).unwrap(), "Olá mundo");
        assert!(parts[1].starts_with("Content-Type: text/html; charset=UTF-8"));
        let pdf = raw.split("--B-mix\r\n").find(|p| p.contains("application/pdf")).unwrap();
        assert!(pdf.contains("filename*=UTF-8''relat%C3%B3rio.pdf"));
        assert_eq!(unb64(body_of(pdf).split("\r\n--").next().unwrap()), vec![0, 1, 2, 255]);
        assert!(raw.contains("Content-Disposition: attachment; filename=\"a.txt\"\r\n"));
    }

    #[test]
    fn long_subjects_fold_into_short_words() {
        let s = "ação ".repeat(30);
        let h = encode_words(&s);
        assert!(h.lines().all(|l| l.trim_end().len() <= 76), "{h}");
        let back: String = h.split("\r\n ").map(|w| String::from_utf8(unb64(w.trim_start_matches("=?UTF-8?B?").trim_end_matches("?="))).unwrap()).collect();
        assert_eq!(back, s);
        assert_eq!(encode_words("plain"), "plain");
    }

    fn part(mime: &str, text: &str) -> Value {
        json!({ "mimeType": mime, "filename": "", "headers": [{ "name": "Content-Type", "value": format!("{mime}; charset=\"UTF-8\"") }], "body": { "size": text.len(), "data": b64url(text.as_bytes()) } })
    }

    #[test]
    fn reads_a_gmail_payload() {
        let p = json!({
            "mimeType": "multipart/mixed",
            "parts": [
                { "mimeType": "multipart/alternative", "parts": [part("text/plain", "Hi Ana,\r\n\r\n\r\n\r\nsee the report."), part("text/html", "<p>Hi Ana</p>")] },
                { "mimeType": "application/pdf", "filename": "report.pdf", "headers": [], "body": { "attachmentId": "ANG1", "size": 120_000 } },
                { "mimeType": "image/png", "filename": "", "headers": [{ "name": "Content-ID", "value": "<img1>" }], "body": { "attachmentId": "ANG2", "size": 900 } },
            ]
        });
        let mut parts = Parts::default();
        walk(&p, &mut parts);
        assert_eq!(parts.text(), "Hi Ana,\n\nsee the report.");
        assert_eq!(parts.files.len(), 2);
        assert_eq!((parts.files[0].name.as_str(), parts.files[0].id.as_str(), parts.files[0].size), ("report.pdf", "ANG1", 120_000));
        assert_eq!(parts.files[1].name, "(unnamed)");
        // HTML only: the HTML as text.
        let mut h = Parts::default();
        walk(
            &json!({ "mimeType": "multipart/alternative", "parts": [part("text/html", "<div>Code: <b>42</b></div><a href=\"https://example.com/v?a=1&amp;b=2\">Verify</a>")] }),
            &mut h,
        );
        assert_eq!(h.text(), "Code: 42\nVerify (https://example.com/v?a=1&b=2)");
        // Latin-1 bodies.
        let mut l = Parts::default();
        walk(
            &json!({ "mimeType": "text/plain", "headers": [{ "name": "Content-Type", "value": "text/plain; charset=ISO-8859-1" }], "body": { "data": b64url(b"ol\xe1") } }),
            &mut l,
        );
        assert_eq!(l.text(), "olá");
    }

    #[test]
    fn html_as_text() {
        let h = "<html><head><style>p{color:red}</style><title>T</title></head><body><!-- x --><p>Hello&nbsp;&amp; welcome&#33;</p>\n<ul><li>one</li><li>two</li></ul><script>alert(1)</script><table><tr><td>a</td><td>b</td></tr></table><a href='mailto:x@example.com'>x@example.com</a> <a href=\"https://example.com\">https://example.com</a> &unknown; &#x263A;</body></html>";
        assert_eq!(tidy(&html_text(h)), "Hello & welcome!\n\n- one\n- two\n\na b\n\nx@example.com https://example.com &unknown; ☺");
        assert_eq!(entities("Tom &amp; Jerry&#39;s &quot;show&quot;"), "Tom & Jerry's \"show\"");
    }

    #[test]
    fn label_changes() {
        let l = lbl();
        let p = |a: Value| plan(&a, &l);
        assert_eq!(p(json!({ "move_to": "work" })).unwrap(), (vec!["Label_1".to_string()], vec!["INBOX".to_string()]));
        assert_eq!(p(json!({ "move_to": "Clients/Acme", "remove_labels": ["Work"] })).unwrap(), (vec!["Label_2".into()], vec!["Label_1".into(), "INBOX".into()]));
        assert_eq!(p(json!({ "move_to": "inbox" })).unwrap(), (vec!["INBOX".into()], vec![]));
        assert_eq!(p(json!({ "archive": true, "read": true, "starred": true })).unwrap(), (vec!["STARRED".into()], vec!["INBOX".into(), "UNREAD".into()]));
        assert_eq!(p(json!({ "read": false, "starred": false })).unwrap(), (vec!["UNREAD".into()], vec!["STARRED".into()]));
        assert_eq!(p(json!({ "add_labels": "Work, Label_2", "archive": true, "move_to": "Work" })).unwrap(), (vec!["Label_1".into(), "Label_2".into()], vec!["INBOX".into()]));
        assert!(p(json!({ "move_to": "INBOX", "archive": true })).unwrap_err().contains("both added and removed"));
        assert!(p(json!({ "move_to": "Nope" })).unwrap_err().contains("No label \"Nope\""));
        assert!(p(json!({ "move_to": "trash" })).unwrap_err().contains("use trash"));
        // System labels work without the list.
        assert_eq!(plan(&json!({ "add_labels": ["important", "category_updates"] }), &[]).unwrap().0, vec!["IMPORTANT".to_string(), "CATEGORY_UPDATES".into()]);
        assert_eq!(describe(&["Label_1".into()], &["INBOX".into()], &l), "+Work, -INBOX");
    }

    #[test]
    fn replies() {
        assert_eq!(split_addrs("\"Doe, Jane\" <jane@example.com>, bo@example.com; <c@example.com>"), vec!["\"Doe, Jane\" <jane@example.com>", "bo@example.com", "<c@example.com>"]);
        assert_eq!(addr_email(" Ana <Ana@Example.COM> "), "ana@example.com");
        assert_eq!(addr_email("bo@example.com"), "bo@example.com");
        let cc = reply_all_cc(
            "me@example.com",
            "Ana <ana@example.com>",
            "Me <me@example.com>, ana@example.com, \"Doe, Jane\" <jane@example.com>, ",
            "bo@example.com, Jane <JANE@example.com>",
        );
        assert_eq!(cc, "bo@example.com, Jane <JANE@example.com>");
        assert_eq!(re_subject("Lunch"), "Re: Lunch");
        assert_eq!(re_subject("RE: Lunch"), "RE: Lunch");
    }

    #[test]
    fn accounts_and_their_errors() {
        let acc = vec!["ana@example.com".to_string(), "Work@Example.com".to_string()];
        assert_eq!(resolve("", &acc).unwrap(), "ana@example.com");
        assert_eq!(resolve(" work@example.com ", &acc).unwrap(), "Work@Example.com");
        let e = resolve("bo@example.com", &acc).unwrap_err();
        assert!(e.contains("No Gmail account bo@example.com is connected") && e.contains("ana@example.com, Work@Example.com") && e.contains("default (ana@example.com)"), "{e}");
        assert!(resolve("", &[]).unwrap_err().contains("isn't signed in"));
        let l = list_accounts(&acc).unwrap();
        assert!(l.starts_with("2 Gmail accounts connected") && l.contains("- ana@example.com (default)\n- Work@Example.com\n"), "{l}");
        assert!(list_accounts(&[]).is_err());
        // Every tool takes account; search also "all"; agents can list the accounts.
        let t = tools();
        assert!(t.iter().all(|t| t["name"] == "accounts" || t["inputSchema"]["properties"]["account"]["type"] == "string"));
        assert!(t.iter().find(|t| t["name"] == "search").unwrap()["inputSchema"]["properties"]["account"]["description"].as_str().unwrap().contains("\"all\""));
        assert!(t.iter().any(|t| t["name"] == "accounts"));
    }

    #[test]
    fn small_things() {
        assert_eq!(charset("text/plain; charset=\"ISO-8859-1\"; format=flowed"), "iso-8859-1");
        assert_eq!(charset("text/plain"), "utf-8");
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(size(512), "512 B");
        assert_eq!(size(2048), "2 KB");
        assert_eq!(size(3 * 1_048_576), "3.0 MB");
        assert_eq!(mime_for("a.PDF"), "application/pdf");
        assert_eq!(strs(&json!({ "ids": "a, b,," }), "ids"), vec!["a", "b"]);
        assert_eq!(addrs(&json!({ "to": ["a@example.com", " b@example.com"] }), "to"), "a@example.com, b@example.com");
        assert!(clip(&"x".repeat(300), 200).contains("100 more characters"));
        // Every tool has a schema the CLIs accept: arrays name their items.
        for t in tools() {
            for (_, p) in t["inputSchema"]["properties"].as_object().unwrap() {
                assert!(p["type"] != "array" || p["items"].is_object(), "{t}");
            }
        }
    }
}
