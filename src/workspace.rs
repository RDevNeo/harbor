//! This PC's files and shell for an agent on another device. With a device's "Work on
//! this PC's files" on, the remote Claude Code runs without its own Bash, Read, Write,
//! Edit, Glob and Grep, and the bridge's `origin` server offers these instead: they run
//! here, in the chat's project, so its edits, builds and git commits all happen in one
//! place. Inputs and outputs follow Claude Code's tools, so the agent uses them alike.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Every tool, in the order they're listed.
pub const TOOLS: &[&str] = &["bash", "read", "write", "edit", "glob", "grep"];
/// Claude Code's own tools these stand in for, and others that would act on the device's
/// files or shell (LSP, Monitor, worktrees), disallowed there.
pub const REPLACED: &str = "Bash,BashOutput,KillShell,Read,Edit,MultiEdit,Write,NotebookEdit,Glob,Grep,LS,LSP,Monitor,EnterWorktree,ExitWorktree";
/// Lines `read` returns unless asked for more, and the longest line it keeps whole.
const READ_LINES: usize = 2000;
const LINE_MAX: usize = 2000;
/// Paths `glob` lists at most.
const GLOB_MAX: usize = 100;
/// `grep` output beyond this keeps only its start.
const GREP_MAX: usize = 30_000;

/// The tools a turn gets for its access: plan (read only) reads and searches; auto-edit
/// also writes and edits but runs no commands (as a local turn there); a team lead
/// reads and, with full access, runs commands, but doesn't edit (its local tools are the same).
pub fn for_access(access: &str, lead: bool) -> Vec<String> {
    let names: &[&str] = match () {
        _ if access == "plan" || lead && access != "full" => &["read", "glob", "grep"],
        _ if lead => &["bash", "read", "glob", "grep"],
        _ if access == "edits" => &["read", "write", "edit", "glob", "grep"],
        _ => TOOLS,
    };
    names.iter().map(|s| s.to_string()).collect()
}

/// Told to the agent with the device's note: where its files are and how to reach them.
pub fn note(tools: &[String], cwd: &Path) -> String {
    let host = crate::remote::hostname();
    let list = tools.iter().map(|t| format!("mcp__origin__{t}")).collect::<Vec<_>>().join(", ");
    let mut s = format!(
        "Your workspace is on '{host}', not on the device: the project is {} there, and your shell, git and file tools ({list}) run on '{host}'. Use them like Claude Code's Bash, Read, Write, Edit, Glob and Grep (those are off); paths are '{host}' paths.",
        cwd.display()
    );
    // The project's CLAUDE.md files are here, so the device's Claude can't find them.
    for f in memory_files(cwd) {
        if let Ok(text) = std::fs::read_to_string(&f) {
            let text: String = text.chars().take(20_000).collect();
            s.push_str(&format!("\n\nContents of {} (project instructions on '{host}'):\n\n{}", f.display(), text.trim()));
        }
    }
    s
}

/// CLAUDE.md and CLAUDE.local.md in the project and the folders above it, up to (not
/// including) home, outermost first.
fn memory_files(cwd: &Path) -> Vec<PathBuf> {
    let home = crate::store::home();
    let mut dirs: Vec<&Path> = cwd.ancestors().take_while(|d| *d != home && d.starts_with(&home)).collect();
    dirs.reverse();
    dirs.iter().flat_map(|d| ["CLAUDE.md", "CLAUDE.local.md"].map(|n| d.join(n))).filter(|f| f.is_file()).collect()
}

/// A path the agent gave: ~ is home here, relative is from the project.
pub fn resolve(cwd: &Path, p: &str) -> PathBuf {
    let p = p.trim();
    match p {
        "" => cwd.to_path_buf(),
        "~" => crate::store::home(),
        _ if p.starts_with("~/") => crate::store::home().join(&p[2..]),
        _ => cwd.join(p),
    }
}

/// Claude Code's Edit: `old` must be in `text` once (or every time, with `all`); an
/// empty `old` writes `new` into an empty or new file. A file with CRLF line ends
/// matches `old` written with LF. The new text and how many were replaced.
pub fn replace(text: &str, old: &str, new: &str, all: bool) -> Result<(String, usize), String> {
    if old == new {
        return Err("old_string and new_string are the same; nothing to change".into());
    }
    if old.is_empty() {
        return if text.is_empty() { Ok((new.to_string(), 1)) } else { Err("old_string is empty but the file isn't; use write to replace a whole file".into()) };
    }
    let crlf = |s: &str| s.replace("\r\n", "\n").replace('\n', "\r\n");
    let (old, new) = if !text.contains(old) && text.contains("\r\n") && text.contains(&crlf(old)) { (crlf(old), crlf(new)) } else { (old.to_string(), new.to_string()) };
    match text.matches(&old).count() {
        0 => Err("old_string isn't in the file (it must match exactly, whitespace included); read the file again".into()),
        n if n > 1 && !all => Err(format!("old_string is in the file {n} times; give more context to make it unique, or set replace_all")),
        n => Ok((if all { text.replace(&old, &new) } else { text.replacen(&old, &new, 1) }, n)),
    }
}

/// Lines `offset..` (1-based) of `text`, at most `limit`, numbered like `cat -n`.
pub fn numbered(text: &str, offset: usize, limit: usize) -> String {
    let start = offset.max(1);
    let mut out = String::new();
    for (i, line) in text.lines().enumerate().skip(start - 1).take(limit) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let line = if line.len() > LINE_MAX { format!("{}… [line cut]", &line[..(0..=LINE_MAX).rev().find(|i| line.is_char_boundary(*i)).unwrap_or(0)]) } else { line.to_string() };
        out.push_str(&format!("{:>6}\t{line}\n", i + 1));
    }
    out
}

pub fn tools(names: &[String]) -> Vec<Value> {
    let host = crate::remote::hostname();
    let all = vec![
        json!({
            "name": "bash",
            "description": format!("Run a bash command on {host} (where the project and its git repo are), not on the machine you run on. The working folder is kept between calls (starts in the project); stdout and stderr are returned together with the exit code. Use it for git, builds, tests and anything else Bash would do."),
            "inputSchema": { "type": "object", "properties": {
                "command": { "type": "string", "description": "The command" },
                "timeout": { "type": "integer", "description": "Milliseconds before it is stopped (default 120000, at most 600000)" },
                "description": { "type": "string", "description": "What it does, in a few words" },
                "run_in_background": { "type": "boolean", "description": "Start it and return at once; its output goes to a log file there (read it with read)" },
            }, "required": ["command"] },
        }),
        json!({
            "name": "read",
            "description": format!("Read a file on {host}: lines numbered like cat -n, 2000 from the start unless offset/limit say otherwise. Images come back as images."),
            "inputSchema": { "type": "object", "properties": {
                "file_path": { "type": "string", "description": "Absolute path (relative: from the project)" },
                "offset": { "type": "integer", "description": "First line (1-based)" },
                "limit": { "type": "integer", "description": "How many lines" },
            }, "required": ["file_path"] },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "write",
            "description": format!("Write a file on {host}, replacing it if it exists (folders are created). Prefer edit for changes to an existing file."),
            "inputSchema": { "type": "object", "properties": {
                "file_path": { "type": "string", "description": "Absolute path (relative: from the project)" },
                "content": { "type": "string" },
            }, "required": ["file_path", "content"] },
        }),
        json!({
            "name": "edit",
            "description": format!("Replace exact text in a file on {host}. old_string must match the file exactly (whitespace and indentation included) and be unique, unless replace_all. An empty old_string creates a new file."),
            "inputSchema": { "type": "object", "properties": {
                "file_path": { "type": "string", "description": "Absolute path (relative: from the project)" },
                "old_string": { "type": "string" },
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean", "description": "Replace every occurrence (default false)" },
            }, "required": ["file_path", "old_string", "new_string"] },
        }),
        json!({
            "name": "glob",
            "description": format!("Find files on {host} by glob pattern (\"**/*.rs\", \"src/**/*.ts\"), newest first; .gitignore'd files are skipped."),
            "inputSchema": { "type": "object", "properties": {
                "pattern": { "type": "string" },
                "path": { "type": "string", "description": "Folder to search (default: the project)" },
            }, "required": ["pattern"] },
            "annotations": { "readOnlyHint": true },
        }),
        json!({
            "name": "grep",
            "description": format!("Search file contents on {host} with ripgrep (regex)."),
            "inputSchema": { "type": "object", "properties": {
                "pattern": { "type": "string", "description": "Regular expression (ripgrep syntax)" },
                "path": { "type": "string", "description": "File or folder (default: the project)" },
                "glob": { "type": "string", "description": "Only files matching this glob (\"*.js\", \"*.{ts,tsx}\")" },
                "type": { "type": "string", "description": "ripgrep file type (js, py, rust…)" },
                "output_mode": { "type": "string", "enum": ["content", "files_with_matches", "count"], "description": "Default files_with_matches" },
                "-i": { "type": "boolean", "description": "Ignore case" },
                "-n": { "type": "boolean", "description": "Line numbers (content mode; default true)" },
                "-A": { "type": "integer" }, "-B": { "type": "integer" }, "-C": { "type": "integer" },
                "multiline": { "type": "boolean", "description": "Patterns can span lines; . matches newlines" },
                "head_limit": { "type": "integer", "description": "Only the first N lines of output" },
            }, "required": ["pattern"] },
            "annotations": { "readOnlyHint": true },
        }),
    ];
    all.into_iter().filter(|t| names.iter().any(|n| t["name"] == n.as_str())).collect()
}

/// The bash tool's folder per chat, kept between calls and turns.
static CWDS: LazyLock<Mutex<HashMap<i64, PathBuf>>> = LazyLock::new(Default::default);

fn text(ok: bool, t: impl Into<String>) -> (bool, Vec<Value>) {
    (ok, vec![json!({ "type": "text", "text": t.into() })])
}

/// Runs tool `name` for chat `chat_id` in project `cwd`: whether it worked, and its content.
pub fn call(cwd: &Path, chat_id: i64, name: &str, a: &Value) -> (bool, Vec<Value>) {
    let path = |k: &str| a[k].as_str().map(|p| resolve(cwd, p));
    match name {
        "bash" => bash(cwd, chat_id, a),
        "read" => {
            let Some(p) = path("file_path") else { return text(false, "file_path is required") };
            if p.is_dir() {
                return text(false, format!("{} is a folder; list it with bash (ls)", p.display()));
            }
            let bytes = match std::fs::read(&p) {
                Ok(b) => b,
                Err(e) => return text(false, format!("cannot read {}: {e}", p.display())),
            };
            let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
            if let Some(mime) = match ext.as_str() {
                "png" => Some("image/png"),
                "jpg" | "jpeg" => Some("image/jpeg"),
                "gif" => Some("image/gif"),
                "webp" => Some("image/webp"),
                _ => None,
            } {
                return (true, vec![json!({ "type": "image", "data": crate::agent::base64(&bytes), "mimeType": mime })]);
            }
            let t = String::from_utf8_lossy(&bytes);
            if t.is_empty() {
                return text(true, format!("({} is empty)", p.display()));
            }
            let offset = a["offset"].as_u64().unwrap_or(1) as usize;
            let limit = a["limit"].as_u64().unwrap_or(READ_LINES as u64) as usize;
            let out = numbered(&t, offset, limit);
            let total = t.lines().count();
            let more = if offset.max(1) - 1 + limit < total { format!("\n[{total} lines in all; read on with offset]") } else { String::new() };
            text(true, if out.is_empty() { format!("(the file has {total} lines)") } else { out + &more })
        }
        "write" => {
            let (Some(p), Some(content)) = (path("file_path"), a["content"].as_str()) else { return text(false, "file_path and content are required") };
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match std::fs::write(&p, content) {
                Ok(()) => text(true, format!("Wrote {} ({} bytes)", p.display(), content.len())),
                Err(e) => text(false, format!("cannot write {}: {e}", p.display())),
            }
        }
        "edit" => {
            let (Some(p), Some(old), Some(new)) = (path("file_path"), a["old_string"].as_str(), a["new_string"].as_str()) else {
                return text(false, "file_path, old_string and new_string are required");
            };
            let cur = match std::fs::read_to_string(&p) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && old.is_empty() => String::new(),
                Err(e) => return text(false, format!("cannot read {}: {e}", p.display())),
            };
            match replace(&cur, old, new, a["replace_all"].as_bool().unwrap_or(false)) {
                Ok((out, n)) => {
                    if let Some(dir) = p.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    match std::fs::write(&p, out) {
                        Ok(()) => text(true, format!("Edited {} ({n} replacement{})", p.display(), if n == 1 { "" } else { "s" })),
                        Err(e) => text(false, format!("cannot write {}: {e}", p.display())),
                    }
                }
                Err(e) => text(false, e),
            }
        }
        "glob" => {
            let Some(pattern) = a["pattern"].as_str().filter(|p| !p.is_empty()) else { return text(false, "pattern is required") };
            let dir = path("path").unwrap_or_else(|| cwd.to_path_buf());
            let out = rg(&["--files", "--hidden", "-g", "!.git", "-g", pattern], &dir);
            let out = match out {
                Ok(o) => o,
                Err(e) => return text(false, e),
            };
            let mut files: Vec<(std::time::SystemTime, &str)> = out.lines().map(|l| (std::fs::metadata(l).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), l)).collect();
            files.sort_by(|a, b| b.0.cmp(&a.0));
            let n = files.len();
            let mut s = files.iter().take(GLOB_MAX).map(|(_, f)| *f).collect::<Vec<_>>().join("\n");
            if n > GLOB_MAX {
                s.push_str(&format!("\n[{n} files in all; the newest {GLOB_MAX} shown, narrow the pattern]"));
            }
            text(true, if s.is_empty() { "No files found".into() } else { s })
        }
        "grep" => {
            let Some(pattern) = a["pattern"].as_str() else { return text(false, "pattern is required") };
            let dir = path("path").unwrap_or_else(|| cwd.to_path_buf());
            let mut args: Vec<String> = ["--hidden", "-g", "!.git", "--no-heading", "--color", "never"].map(String::from).to_vec();
            match a["output_mode"].as_str().unwrap_or("files_with_matches") {
                "content" => {
                    if a["-n"].as_bool().unwrap_or(true) {
                        args.push("-n".into());
                    }
                    for k in ["-A", "-B", "-C"] {
                        if let Some(n) = a[k].as_u64() {
                            args.extend([k.to_string(), n.to_string()]);
                        }
                    }
                }
                "count" => args.push("-c".into()),
                _ => args.push("-l".into()),
            }
            if a["-i"].as_bool() == Some(true) {
                args.push("-i".into());
            }
            if a["multiline"].as_bool() == Some(true) {
                args.extend(["-U".into(), "--multiline-dotall".into()]);
            }
            if let Some(g) = a["glob"].as_str().filter(|g| !g.is_empty()) {
                args.extend(["-g".into(), g.into()]);
            }
            if let Some(t) = a["type"].as_str().filter(|t| !t.is_empty()) {
                args.extend(["-t".into(), t.into()]);
            }
            args.extend(["-e".into(), pattern.into()]);
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            match rg(&refs, &dir) {
                Ok(o) if o.is_empty() => text(true, "No matches"),
                Ok(o) => {
                    let mut o = match a["head_limit"].as_u64() {
                        Some(n) => o.lines().take(n as usize).collect::<Vec<_>>().join("\n"),
                        None => o,
                    };
                    if o.len() > GREP_MAX {
                        let cut = (0..=GREP_MAX).rev().find(|i| o.is_char_boundary(*i)).unwrap_or(0);
                        o.truncate(cut);
                        o.push_str("\n[… output cut; narrow the search or use head_limit]");
                    }
                    text(true, o)
                }
                Err(e) => text(false, e),
            }
        }
        _ => text(false, format!("No tool {name} here")),
    }
}

/// ripgrep over `target` (a folder or file); its output (empty: nothing found).
fn rg(args: &[&str], target: &Path) -> Result<String, String> {
    let out = std::process::Command::new("rg")
        .args(args)
        .arg(target)
        .env("PATH", crate::providers::child_path())
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("ripgrep (rg) can't run on {}: {e}", crate::remote::hostname()))?;
    match out.status.code() {
        Some(0) | Some(1) => Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string()),
        _ => Err(format!("rg: {}", String::from_utf8_lossy(&out.stderr).trim())),
    }
}

fn bash(cwd: &Path, chat_id: i64, a: &Value) -> (bool, Vec<Value>) {
    let Some(command) = a["command"].as_str().filter(|c| !c.trim().is_empty()) else { return text(false, "command is required") };
    let here = CWDS.lock().unwrap().get(&chat_id).filter(|d| d.is_dir()).cloned().unwrap_or_else(|| cwd.to_path_buf());
    let Ok(tag) = crate::bridge::token() else { return text(false, "no randomness for a log name") };
    if a["run_in_background"].as_bool() == Some(true) {
        let log = std::env::temp_dir().join(format!("harbor-bash-{}.log", &tag[..12]));
        // Owner-only and new: /tmp is shared with every account here.
        let f = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&log)
        };
        let Ok(f) = f else { return text(false, format!("cannot create {}", log.display())) };
        let mut cmd = crate::bridge::shell_command(&format!("exec 2>&1\n{command}"), &here);
        let spawned = f.try_clone().and_then(|f2| cmd.stdin(std::process::Stdio::null()).stdout(f).stderr(f2).spawn());
        return match spawned {
            Ok(mut child) => {
                let pid = child.id();
                // Reaped when it ends; it outlives the turn if it runs long.
                std::thread::spawn(move || child.wait());
                text(true, format!("Started in the background (process group {pid}); its output goes to {}. Read that file to follow it; stop it with `kill -- -{pid}`.", log.display()))
            }
            Err(e) => text(false, format!("cannot run it in {}: {e}", here.display())),
        };
    }
    // The folder it ends in is the next call's.
    let pwd = std::env::temp_dir().join(format!("harbor-pwd-{}", &tag[..12]));
    let script = format!("trap 'pwd >| {} 2>/dev/null' EXIT\nexec 2>&1\n{command}", crate::remote::quote(&pwd.to_string_lossy()));
    let ms = a["timeout"].as_u64().unwrap_or(120_000).clamp(1000, 600_000);
    let (status, out) = crate::bridge::shell(&script, &here, Duration::from_millis(ms));
    if let Some(d) = std::fs::read_to_string(&pwd).ok().map(|s| PathBuf::from(s.trim_end_matches('\n'))).filter(|d| d.is_dir()) {
        CWDS.lock().unwrap().insert(chat_id, d);
    }
    let _ = std::fs::remove_file(&pwd);
    let out = out.trim_end();
    match status {
        Ok(0) => text(true, if out.is_empty() { "(no output)".to_string() } else { out.to_string() }),
        Ok(code) => text(false, format!("{out}\n[exit {code}]")),
        Err(e) if e.is_empty() => text(false, format!("{out}\n[stopped after {} s]", ms / 1000)),
        Err(e) => text(false, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_like_claude_edit() {
        assert_eq!(replace("a b a", "b", "c", false), Ok(("a c a".into(), 1)));
        assert!(replace("a b a", "a", "x", false).unwrap_err().contains("2 times"));
        assert_eq!(replace("a b a", "a", "x", true), Ok(("x b x".into(), 2)));
        assert!(replace("abc", "z", "y", false).unwrap_err().contains("isn't in the file"));
        assert!(replace("abc", "b", "b", false).is_err());
        assert_eq!(replace("", "", "new file\n", false), Ok(("new file\n".into(), 1)));
        assert!(replace("x", "", "y", false).is_err());
        // CRLF files match LF old_string, and keep CRLF.
        assert_eq!(replace("one\r\ntwo\r\n", "one\ntwo", "1\n2", false), Ok(("1\r\n2\r\n".into(), 1)));
    }

    #[test]
    fn paths_and_numbering() {
        let cwd = Path::new("/p/proj");
        assert_eq!(resolve(cwd, ""), cwd);
        assert_eq!(resolve(cwd, "src/a.rs"), Path::new("/p/proj/src/a.rs"));
        assert_eq!(resolve(cwd, "/etc/x"), Path::new("/etc/x"));
        assert_eq!(resolve(cwd, "~/x"), crate::store::home().join("x"));
        assert_eq!(numbered("a\r\nb\nc\n", 2, 1), "     2\tb\n");
        assert_eq!(numbered("a\nb", 1, 10), "     1\ta\n     2\tb\n");
        assert_eq!(for_access("plan", false), ["read", "glob", "grep"]);
        assert!(!for_access("edits", false).contains(&"bash".to_string()));
        assert_eq!(for_access("full", false).len(), TOOLS.len());
        // A lead runs commands only with full access.
        assert_eq!(for_access("plan", true), ["read", "glob", "grep"]);
        assert_eq!(for_access("edits", true), ["read", "glob", "grep"]);
        assert!(for_access("full", true).contains(&"bash".to_string()));
        assert_eq!(tools(&for_access("plan", false)).len(), 3);
    }

    #[test]
    fn tools_run_in_the_project() {
        let dir = std::env::temp_dir().join(format!("harbor-ws-{}", crate::bridge::token().unwrap()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let id = -7;
        let t = |r: (bool, Vec<Value>)| (r.0, r.1[0]["text"].as_str().unwrap_or("").to_string());
        assert!(t(call(&dir, id, "write", &json!({ "file_path": "sub/f.txt", "content": "hello\nworld\n" }))).0);
        assert_eq!(t(call(&dir, id, "read", &json!({ "file_path": dir.join("sub/f.txt").to_string_lossy() }))).1, "     1\thello\n     2\tworld\n");
        assert!(t(call(&dir, id, "edit", &json!({ "file_path": "sub/f.txt", "old_string": "world", "new_string": "there" }))).0);
        assert_eq!(std::fs::read_to_string(dir.join("sub/f.txt")).unwrap(), "hello\nthere\n");
        assert!(t(call(&dir, id, "glob", &json!({ "pattern": "**/*.txt" }))).1.ends_with("sub/f.txt"));
        assert!(t(call(&dir, id, "grep", &json!({ "pattern": "th.re", "output_mode": "content" }))).1.contains(":2:there"));
        // The folder carries over to the next call; a failing command says its code.
        assert!(t(call(&dir, id, "bash", &json!({ "command": "cd sub" }))).0);
        assert_eq!(t(call(&dir, id, "bash", &json!({ "command": "basename \"$PWD\"; ls" }))).1, "sub\nf.txt");
        assert_eq!(t(call(&dir, id, "bash", &json!({ "command": "echo no >&2; exit 3" }))), (false, "no\n[exit 3]".into()));
        assert!(t(call(&dir, id, "bash", &json!({ "command": "sleep 5", "timeout": 1000 }))).1.contains("stopped"));
        CWDS.lock().unwrap().remove(&id);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
