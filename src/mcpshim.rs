//! `harbor mcp --chat <id> --role lead|sub`: a stdio MCP server that agent CLIs
//! load. It only describes the tools and relays each call to the running app
//! over the Unix socket, so it lives exactly as long as the agent's turn.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

fn prop(t: &str, d: &str) -> Value {
    json!({ "type": t, "description": d })
}

fn tool(name: &str, desc: &str, props: Value, required: &[&str]) -> Value {
    json!({ "name": name, "description": desc, "inputSchema": { "type": "object", "properties": props, "required": required } })
}

pub fn tools(role: &str) -> Vec<Value> {
    let mut v = vec![
        tool(
            "list_processes",
            "Long-running processes Harbor runs for this project (dev servers, watchers…): status, command and URL.",
            json!({}),
            &[],
        ),
        tool(
            "process_logs",
            "Recent output of a process started with start_process.",
            json!({ "name": prop("string", "Process name"), "lines": prop("integer", "How many lines (default 60)") }),
            &["name"],
        ),
        tool("stop_process", "Stop a process (and everything it started).", json!({ "name": prop("string", "Process name") }), &["name"]),
        tool(
            "start_process",
            "Run a long-running or slow command (dev server, watcher, data pull, long build) owned by Harbor, so it survives your turn. Returns at once; you get a [process name] message when it prints a local URL or exits.",
            json!({
                "name": prop("string", "Short name, e.g. 'dev', 'convex', 'db-pull'"),
                "command": prop("string", "Shell command, e.g. 'npm run dev'"),
                "cwd": prop("string", "Folder, relative to the project (default: project root)"),
            }),
            &["name", "command"],
        ),
        tool(
            "list_agents",
            "List the project's agents: name, provider/model, status (running/idle), current task and last report.",
            json!({}),
            &[],
        ),
        tool(
            "find_chats",
            "Find Harbor chats by title or sub-agent name (every word must match), across all projects and PCs: title, project, PC, status and its link (harbor://chat/…) to put in a reply so the user can open it.",
            json!({ "query": prop("string", "Words of the title or agent name (empty: the most recent chats)") }),
            &[],
        ),
        tool(
            "show_media",
            "Show the user an image (png, jpg, gif, webp, svg) or a video (mp4, webm, mov) in your reply, inline in the chat on their PC and phone. Call it once per file.",
            json!({
                "path": prop("string", "The file: absolute, relative to the project, or an https URL"),
                "caption": prop("string", "A short caption (optional)"),
            }),
            &["path"],
        ),
    ];
    if role == "lead" {
        v.extend([
            tool(
                "spawn_agent",
                "Start a subagent that works in the project folder with full tools. Give it a short unique name and a complete, self-contained task. It reports back to you when its turn ends.",
                json!({
                    "name": prop("string", "Short handle, e.g. 'tests', 'api', 'reviewer'"),
                    "task": prop("string", "What to do, with all context it needs"),
                    "account": prop("string", "Provider account id from list_models (default: your own account)"),
                    "model": prop("string", "Model id from list_models (default: your model)"),
                    "effort": prop("string", "Reasoning effort, e.g. low/medium/high (optional)"),
                }),
                &["name", "task"],
            ),
            tool(
                "open_chat",
                "Open a new chat (a thread in the sidebar, on the user's PC and phone, like one the user starts) whose agent starts on `prompt` at once. Use it for an independent topic the user wants as its own thread; use spawn_agent for work that serves this chat. Returns the new chat's id.",
                json!({
                    "prompt": prop("string", "Its first message: a complete, self-contained request"),
                    "project": prop("string", "Project name or folder (default: this chat's project)"),
                    "title": prop("string", "Sidebar title (default: the prompt's first line)"),
                    "account": prop("string", "Claude account id from list_models (default: yours)"),
                    "model": prop("string", "Model id from list_models (default: yours)"),
                    "effort": prop("string", "Reasoning effort (optional)"),
                    "machine": prop("string", "Another PC of the user's Harbor mesh to run it on (default: this PC)"),
                }),
                &["prompt"],
            ),
            tool(
                "list_chats",
                "The project's chats (sidebar threads): id, title, status (working, queued, idle, settled) and link (harbor://chat/…, to put in a reply).",
                json!({ "project": prop("string", "Project name or folder (default: this chat's project)") }),
                &[],
            ),
            tool(
                "message_chat",
                "Send a message to another chat's agent (by id from list_chats or open_chat, or its title). It starts a turn with it, or reads it after the current one.",
                json!({ "chat": prop("string", "Chat id or title"), "text": prop("string", "Message") }),
                &["chat", "text"],
            ),
            tool(
                "message_agent",
                "Send a message to a subagent. If it is idle it starts a new turn with it; if busy it reads it with read_messages or after its turn.",
                json!({ "agent": prop("string", "Agent name"), "text": prop("string", "Message") }),
                &["agent", "text"],
            ),
            tool(
                "read_agent",
                "Read the recent transcript of a subagent (its messages, tool calls and results).",
                json!({ "agent": prop("string", "Agent name"), "items": prop("integer", "How many recent entries (default 20)") }),
                &["agent"],
            ),
            tool("stop_agent", "Stop a subagent's running turn.", json!({ "agent": prop("string", "Agent name") }), &["agent"]),
            tool(
                "list_models",
                "Providers, accounts and models you can give to subagents, with each account's current usage.",
                json!({}),
                &[],
            ),
            tool(
                "snooze",
                "Wake yourself up later. After the given minutes you get a '[wake]' message with the reason. End your turn after calling it.",
                json!({ "minutes": prop("number", "Minutes from now"), "reason": prop("string", "What to do when you wake up") }),
                &["minutes", "reason"],
            ),
            tool("cancel_snooze", "Cancel all pending wake-ups of this project.", json!({}), &[]),
            tool(
                "create_webhook",
                "Create a URL other services (GitHub, Vercel, Stripe, CI…) can POST to. Each request arrives to you as a '[webhook name]' message with its body.",
                json!({ "name": prop("string", "Short name, e.g. 'github-push'"), "description": prop("string", "What it is for") }),
                &["name"],
            ),
            tool("list_webhooks", "List this project's webhooks and their URLs.", json!({}), &[]),
            tool("delete_webhook", "Delete a webhook by name.", json!({ "name": prop("string", "Webhook name") }), &["name"]),
        ]);
    } else {
        v.extend([
            tool(
                "send_message",
                "Send a message to a teammate (by name) or to the lead ('lead'). Use it to coordinate, hand off or ask.",
                json!({ "to": prop("string", "Agent name or 'lead'"), "text": prop("string", "Message") }),
                &["to", "text"],
            ),
            tool("read_messages", "Read messages other agents sent you since your turn started.", json!({}), &[]),
        ]);
    }
    v
}

fn call_app(chat: i64, name: &str, args: &Value) -> (bool, String) {
    let path = std::env::var("HARBOR_SOCK").map(std::path::PathBuf::from).unwrap_or_else(|_| crate::control::socket_path());
    // Harbor may be reloading (a new build): its socket comes back within seconds.
    let t = std::time::Instant::now();
    let mut s = loop {
        match UnixStream::connect(&path) {
            Ok(s) => break s,
            Err(_) if t.elapsed() < std::time::Duration::from_secs(30) => std::thread::sleep(std::time::Duration::from_millis(250)),
            Err(_) => return (false, "Harbor is not running".into()),
        }
    };
    let _ = writeln!(s, "{}", json!({ "chat": chat, "tool": name, "args": args }));
    let mut line = String::new();
    let _ = BufReader::new(&s).read_line(&mut line);
    if line.trim().is_empty() {
        return (false, "Harbor restarted before answering. Check whether it took effect (list_agents, list_processes…) before trying again.".into());
    }
    let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    (v["ok"].as_bool().unwrap_or(false), v["text"].as_str().unwrap_or("no reply").to_string())
}

pub fn run(args: &[String]) {
    let mut chat = 0i64;
    let mut role = "sub".to_string();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--chat" => chat = it.next().and_then(|x| x.parse().ok()).unwrap_or(0),
            "--role" => role = it.next().cloned().unwrap_or_default(),
            _ => {}
        }
    }
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = req.get("id").cloned() else { continue }; // notifications need no answer
        let result = match req["method"].as_str().unwrap_or("") {
            "initialize" => json!({
                "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "harbor", "version": env!("CARGO_PKG_VERSION") },
            }),
            "tools/list" => json!({ "tools": tools(&role) }),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let (ok, text) = call_app(chat, name, &req["params"]["arguments"]);
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

#[cfg(test)]
mod tests {
    #[test]
    fn only_leads_open_chats() {
        let names = |role| super::tools(role).iter().map(|t| t["name"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>();
        for t in ["open_chat", "list_chats", "message_chat"] {
            assert!(names("lead").iter().any(|n| n == t), "{t}");
            assert!(!names("sub").iter().any(|n| n == t), "{t}");
        }
        let open = super::tools("lead").into_iter().find(|t| t["name"] == "open_chat").unwrap();
        assert_eq!(open["inputSchema"]["required"], serde_json::json!(["prompt"]));
    }
}
