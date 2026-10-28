//! What a lead's subagents are doing, without asking it: the live strip over a lead chat's
//! composer ("api · running tests · 2m"), and the one-line entry a finished subagent leaves
//! in the lead's transcript ("api finished: added tests for X"). Both are read straight from
//! agent state (the running turn, its latest tool call, its own final report): no model calls.
//! The phone gets the same rows (`status.agents`, api.rs) and draws them alike.

use crate::app::{App, View};
use crate::icons as ic;
use crate::providers::Kind;
use crate::store::{Item, Role};
use crate::widgets as w;
use eframe::egui::{self, CornerRadius, FontId, Rect, Sense, Stroke, Ui, Vec2, pos2};
use serde_json::{Value, json};

/// From this many running agents on, the strip starts folded into "3 agents working".
pub const FOLD_AT: usize = 3;
/// The longest "doing" text and report line.
const DOING_MAX: usize = 48;
const REPORT_MAX: usize = 110;
const ROW_H: f32 = 26.0;
/// The column on the right that holds Stop all.
const STOP_W: f32 = 30.0;

/// One running subagent as the strip shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: i64,
    pub name: String,
    pub kind: Option<Kind>,
    /// The account badge ("AB") when there are several accounts of a kind.
    pub badge: String,
    pub model: String,
    pub task: String,
    pub doing: String,
    pub secs: u64,
    /// Its tokens and cost so far ("12.4k tok · $0.18"), "" before its first turn ends.
    pub usage: String,
}

/// "3 agents working", "1 agent working  ·  2 queued".
pub fn title(n: usize, queued: usize) -> String {
    let t = if n == 1 { "1 agent working".to_string() } else { format!("{n} agents working") };
    if queued > 0 { format!("{t}  ·  {queued} queued") } else { t }
}

/// How long an agent has run, short: "40s", "2m", "1h 5m".
pub fn short_elapsed(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        _ => format!("{}h {}m", secs / 3600, secs % 3600 / 60),
    }
}

/// The logo file (assets/logos) of a provider, and whether it is a mask tinted with the text colour.
pub fn logo(kind: Kind) -> (&'static str, bool) {
    match kind {
        Kind::Claude => ("p-claude-color.rgba", false),
        Kind::Codex => ("p-openai.a8", true),
        Kind::Cursor => ("p-cursor.a8", true),
        Kind::Grok => ("p-grok.a8", true),
        Kind::Gemini => ("p-gemini-color.rgba", false),
        Kind::Meta => ("p-meta-color.rgba", false),
        Kind::OpenCode => ("p-opencode.a8", true),
    }
}

fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out = out.trim_end().to_string();
    out.push('…');
    out
}

/// A path as short as it reads well: relative to the project, else its last two parts.
fn short_path(path: &str, root: &str) -> String {
    let p = path.trim().trim_matches(['"', '\'']);
    let root = root.trim_end_matches('/');
    let rel = match p.strip_prefix(root).and_then(|r| r.strip_prefix('/')) {
        Some(r) if !root.is_empty() && !r.is_empty() => r.to_string(),
        _ => {
            let parts: Vec<&str> = p.trim_end_matches('/').rsplit('/').take(2).collect();
            parts.into_iter().rev().collect::<Vec<_>>().join("/")
        }
    };
    if rel.chars().count() > 36 {
        let file = rel.rsplit('/').next().unwrap_or(&rel);
        return clip(&format!("…/{file}"), 36);
    }
    rel
}

/// A shell command as an activity: "running tests", "building", "running npm install".
fn shell_doing(cmd: &str) -> String {
    // The command that matters: past `cd … &&` and leading VAR=value assignments.
    let last = cmd.split("&&").map(str::trim).find(|p| !p.starts_with("cd ") && !p.is_empty()).unwrap_or(cmd.trim());
    let words: Vec<&str> = last.split_whitespace().skip_while(|w| w.contains('=') && !w.starts_with('-')).collect();
    let line = words.join(" ");
    let has = |k: &str| line.split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_').any(|w| w == k);
    let first = words.first().map(|w| w.rsplit('/').next().unwrap_or(w)).unwrap_or("");
    let second = words.get(1).copied().unwrap_or("");
    if has("test") || has("tests") || has("pytest") || has("jest") || has("vitest") {
        return "running tests".into();
    }
    if (first == "build.sh" || has("cargo") || has("npm") || has("pnpm") || has("make") || has("gradle") || has("tsc")) && (has("check") || has("build") || first == "make" || first == "tsc" || first == "build.sh") {
        return "building".into();
    }
    match (first, second) {
        ("git", "commit") => return "committing".into(),
        ("git", "push") => return "pushing".into(),
        ("git", "pull" | "fetch" | "rebase" | "merge") => return "syncing with git".into(),
        ("git", "diff" | "status" | "log" | "show") => return "reviewing changes".into(),
        ("gh", _) => return "using GitHub".into(),
        ("rg" | "grep" | "find" | "fd" | "ls", _) => return "searching files".into(),
        ("cat" | "head" | "tail" | "less" | "sed" | "wc", _) => return "reading files".into(),
        ("sleep", _) => return "waiting".into(),
        ("curl" | "wget", _) => return "fetching a URL".into(),
        _ => {}
    }
    if first.is_empty() {
        return "running a command".into();
    }
    let sub = if !second.is_empty() && second.chars().all(|c| c.is_ascii_lowercase() || c == '-') { format!(" {second}") } else { String::new() };
    clip(&format!("running {first}{sub}"), DOING_MAX)
}

/// One tool call as an activity.
fn tool_doing(name: &str, summary: &str, input: &str, root: &str) -> String {
    // "mcp__harbor__send_message" and Codex's "harbor.send_message" alike.
    let (server, tool) = match name.strip_prefix("mcp__") {
        Some(rest) => rest.split_once("__").unwrap_or(("", rest)),
        None => name.split_once('.').unwrap_or(("", name)),
    };
    let arg = |k: &str| serde_json::from_str::<Value>(input).ok().and_then(|v| v[k].as_str().map(String::from)).unwrap_or_default();
    // Codex's file changes read "update src/x.rs".
    let path = || {
        let s = summary.trim();
        let s = s.split_once(' ').filter(|(k, _)| matches!(*k, "add" | "update" | "delete" | "modify")).map(|(_, p)| p).unwrap_or(s);
        short_path(s, root)
    };
    let s = match (server, tool) {
        ("harbor", "send_message") => format!("messaging {}", arg("to")),
        ("harbor", "start_process") => format!("starting {}", arg("name")),
        ("harbor", "read_messages") => "reading messages".into(),
        ("harbor", "list_agents") => "checking the team".into(),
        ("harbor", "process_logs" | "list_processes") => "checking processes".into(),
        ("harbor", "show_media") => "showing media".into(),
        ("harbor", t) => t.replace('_', " "),
        ("", "Bash" | "Shell" | "shell" | "run_shell_command" | "exec_command" | "bash") => shell_doing(summary),
        ("", "Edit" | "MultiEdit" | "str_replace" | "replace" | "edit_file" | "edit" | "apply_patch" | "NotebookEdit") if !summary.trim().is_empty() => format!("editing {}", path()),
        ("", "Edit" | "MultiEdit" | "str_replace" | "replace" | "edit_file" | "edit" | "apply_patch" | "NotebookEdit") => "editing files".into(),
        ("", "Write" | "write_file" | "create_file" | "write") => format!("writing {}", path()),
        ("", "Read" | "read_file" | "read_many_files" | "view" | "read") => format!("reading {}", path()),
        ("", "Grep" | "Glob" | "LS" | "grep" | "glob" | "search_file_content" | "list_directory" | "codebase_search" | "find") => "searching code".into(),
        ("", "WebSearch" | "web_search" | "google_web_search") => "searching the web".into(),
        ("", "WebFetch" | "web_fetch" | "fetch") => {
            let host = summary.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or("");
            if host.is_empty() { "reading a web page".into() } else { format!("reading {host}") }
        }
        ("", "Task" | "Agent") => "delegating".into(),
        ("", "TodoWrite" | "update_plan" | "todo_write") => "planning".into(),
        ("", t) => t.to_ascii_lowercase().replace('_', " "),
        (srv, t) => format!("{srv} · {t}"),
    };
    clip(&s, DOING_MAX)
}

/// What a running agent is doing now, from its transcript: its latest tool call, thinking,
/// or writing (its report, at the end of a turn).
pub fn doing(items: &[Item], root: &str) -> String {
    for it in items.iter().rev() {
        match it {
            Item::Tool { name, summary, input, .. } => return tool_doing(name, summary, input, root),
            Item::Thinking { .. } => return "thinking".into(),
            Item::Text { text, .. } if !text.trim().is_empty() => return "writing".into(),
            Item::User { .. } | Item::Result { .. } => break,
            _ => {}
        }
    }
    "starting".into()
}

/// The line a finished subagent leaves in its lead's chat: its report's first sentence.
/// "api finished: Added tests for X". A report that is an error says so.
pub fn report_line(name: &str, report: &str) -> String {
    let first = report
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#') && !l.starts_with("```"))
        .map(|l| l.trim_start_matches(['>', '-', '*', ' ']).trim())
        .find(|l| !l.is_empty() && *l != "(no text reply)")
        .unwrap_or("");
    let plain: String = first.replace("**", "").replace('`', "");
    // The first sentence: up to ". " (or the line's end).
    let sentence = plain.split_inclusive(". ").next().unwrap_or(&plain).trim().trim_end_matches('.').trim();
    if sentence.is_empty() {
        return format!("{name} finished");
    }
    match sentence.strip_prefix("Error: ") {
        Some(e) => format!("{name} failed: {}", clip(e, REPORT_MAX)),
        None => format!("{name} finished: {}", clip(sentence, REPORT_MAX)),
    }
}

impl App {
    /// The lead's running subagents as strip rows, longest running first.
    pub fn strip_rows(&self, lead: i64) -> Vec<Row> {
        if self.chat(lead).is_none_or(|c| c.role != Role::Lead) {
            return vec![];
        }
        let root = self.chat(lead).and_then(|c| c.repo_id).and_then(|r| self.repo(r)).map(|r| r.dir().display().to_string()).unwrap_or_default();
        self.running_subs(lead)
            .into_iter()
            .map(|(c, secs)| {
                let acc = self.account(&c.account);
                let items = self.transcripts.get(&c.id).map(|t| t.items.as_slice()).unwrap_or(&[]);
                Row {
                    id: c.id,
                    kind: acc.map(|a| a.kind),
                    badge: acc.map(|a| a.badge.clone()).unwrap_or_default(),
                    model: acc.map(|a| self.model_label(a.kind, &c.model)).unwrap_or_else(|| c.model.clone()),
                    doing: doing(items, &root),
                    task: c.title,
                    name: c.name,
                    secs,
                    usage: Some(crate::cost::of_items(items)).filter(|u| !u.is_empty()).map(|u| u.compact()).unwrap_or_default(),
                }
            })
            .collect()
    }

    /// What changes the strip as the phone sees it (the times count on the phone).
    pub fn strip_key(&self, lead: i64) -> Vec<(i64, String)> {
        self.strip_rows(lead).into_iter().map(|r| (r.id, r.doing)).collect()
    }

    /// `status.agents` for the phone: null without running subagents.
    pub fn strip_json(&self, lead: i64) -> Value {
        let rows = self.strip_rows(lead);
        if rows.is_empty() {
            return Value::Null;
        }
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let list: Vec<Value> = rows
            .iter()
            .map(|r| {
                let file = r.kind.map(|k| logo(k).0).unwrap_or("");
                json!({
                    "id": r.id, "name": r.name, "doing": r.doing, "task": r.task, "model": r.model,
                    "logo": file, "badge": r.badge,
                    "since_ms": now_ms - r.secs as i64 * 1000, "usage": r.usage,
                })
            })
            .collect();
        let queued = self.subs_queued(lead);
        json!({
            "title": title(rows.len(), queued), "folded": rows.len() >= FOLD_AT,
            "header": rows.len() >= FOLD_AT || queued > 0, "rows": list,
        })
    }

    /// The strip over a lead chat's composer while its subagents run; nothing otherwise.
    pub fn agent_strip(&mut self, ui: &mut Ui, lead: i64) {
        let rows = self.strip_rows(lead);
        if rows.is_empty() {
            return;
        }
        let t = self.theme.t;
        let open_id = egui::Id::NULL.with(("agent-strip-open", lead));
        let open = ui.ctx().data(|d| d.get_temp::<bool>(open_id)).unwrap_or(rows.len() < FOLD_AT);
        let folded = rows.len() >= FOLD_AT;
        let queued = self.subs_queued(lead);
        // The title row: always when folded, and to say what's queued.
        let header = folded || queued > 0;
        let open = open || !folded;
        let lines = if open { rows.len() } else { 0 } + usize::from(header);
        let width = ui.available_width();
        let (rect, _) = ui.allocate_exact_size(Vec2::new(width, lines as f32 * ROW_H + 8.0), Sense::hover());
        ui.painter().rect(rect, CornerRadius::same(12), t.bg200, Stroke::new(1.0, t.border()), egui::StrokeKind::Inside);
        // Seconds count while any agent is under a minute; minutes after that.
        let step = rows.iter().map(|r| if r.secs < 60 { std::time::Duration::from_secs(1) } else { w::minute_step(r.secs) }).min().unwrap_or_default();
        w::repaint_in(ui.painter(), rect, step);
        let mut y = rect.top() + 4.0;
        let mut open_chat = None;
        // Stop all, in the top row's corner: as the old waiting bar's, it asks first.
        let sr = Rect::from_min_size(pos2(rect.right() - 4.0 - STOP_W, y), Vec2::new(STOP_W - 2.0, ROW_H));
        if w::overlay(ui, sr, |ui| w::btn(ic::STOP).muted().icon_xs().show(ui)).on_hover_text("Stop all: every running sub-agent, and clear their queues").clicked() {
            self.dialog = Some(crate::app::Dialog::StopAll(lead));
        }
        let row_w = width - 8.0 - STOP_W;
        if header {
            let r = Rect::from_min_size(pos2(rect.left() + 4.0, y), Vec2::new(row_w, ROW_H));
            let resp = ui.interact(r, open_id.with("head"), Sense::click());
            // Folded it unfolds; unfolded (it says what's queued) it opens the Agents panel.
            let resp = resp.on_hover_cursor(egui::CursorIcon::PointingHand);
            if resp.hovered() {
                ui.painter().rect_filled(r, CornerRadius::same(8), t.gray(100));
            }
            let p = ui.painter();
            // The agents' marks, overlapping, then "3 agents working · api, ui, docs".
            let mut x = r.left() + 8.0;
            for row in rows.iter().take(4) {
                if let Some(k) = row.kind {
                    ic::provider(p, Rect::from_center_size(pos2(x + 7.0, r.center().y), Vec2::splat(14.0)), k, &t);
                }
                x += 11.0;
            }
            x += 8.0;
            let head = w::truncated(ui, &title(rows.len(), queued), FontId::new(13.0, crate::theme::medium()), t.fg(), width * 0.5);
            let hw = head.size().x;
            ui.painter().galley(pos2(x, r.center().y - head.size().y / 2.0), head, t.fg());
            x += hw;
            let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
            let rest = w::truncated(ui, &format!("  ·  {}", names.join(", ")), FontId::proportional(13.0), t.subtle(), (r.right() - 30.0 - x).max(0.0));
            ui.painter().galley(pos2(x, r.center().y - rest.size().y / 2.0), rest, t.subtle());
            if folded {
                ic::glyph(ui.painter(), pos2(r.right() - 14.0, r.center().y), if open { ic::UP } else { ic::DOWN }, 12.0, t.subtle());
            }
            if resp.clicked() && folded {
                ui.ctx().data_mut(|d| d.insert_temp(open_id, !open));
            } else if resp.clicked() {
                self.open_team();
            }
            y += ROW_H;
        }
        if open {
            for row in &rows {
                let r = Rect::from_min_size(pos2(rect.left() + 4.0, y), Vec2::new(row_w, ROW_H));
                if self.strip_row(ui, r, row) {
                    open_chat = Some(row.id);
                }
                y += ROW_H;
            }
        }
        ui.add_space(8.0);
        if let Some(id) = open_chat {
            self.open(View::Chat(id));
        }
    }

    /// One agent: mark, name · what it's doing, elapsed on the right. True when clicked.
    fn strip_row(&self, ui: &mut Ui, r: Rect, row: &Row) -> bool {
        let t = self.theme.t;
        let resp = ui.interact(r, egui::Id::NULL.with(("agent-strip-row", row.id)), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
        if resp.hovered() {
            ui.painter().rect_filled(r, CornerRadius::same(8), t.gray(100));
        }
        let p = ui.painter();
        let cy = r.center().y;
        if let Some(k) = row.kind {
            ic::account_mark(p, Rect::from_center_size(pos2(r.left() + 16.0, cy), Vec2::splat(18.0)), k, &row.badge, &t);
        }
        let x = r.left() + 34.0;
        // Name and what it's doing come first: the usage only shows while they keep their room
        // (the hover has it too).
        let elapsed = short_elapsed(row.secs);
        let with_usage = format!("{}  ·  {elapsed}", row.usage);
        let roomy = !row.usage.is_empty() && r.right() - 10.0 - x - w::truncated(ui, &with_usage, FontId::monospace(12.0), t.subtle(), f32::INFINITY).size().x >= 260.0;
        let time = w::truncated(ui, if roomy { &with_usage } else { &elapsed }, FontId::monospace(12.0), t.subtle(), 200.0);
        let right = r.right() - 10.0 - time.size().x;
        let name = w::truncated(ui, &row.name, FontId::new(13.0, crate::theme::medium()), t.fg(), ((right - x) * 0.4).max(30.0));
        let nw = name.size().x;
        let doing = w::truncated(ui, &format!("  ·  {}", row.doing), FontId::proportional(13.0), t.subtle(), (right - 8.0 - x - nw).max(0.0));
        let p = ui.painter();
        p.galley(pos2(x, cy - name.size().y / 2.0), name, t.fg());
        p.galley(pos2(x + nw, cy - doing.size().y / 2.0), doing, t.subtle());
        p.galley(pos2(right, cy - time.size().y / 2.0), time, t.subtle());
        let resp = resp.on_hover_ui(|ui| {
            ui.set_max_width(360.0);
            w::text(ui, &row.name, "strong-14");
            w::subtle(ui, &row.model, "label-12-mono");
            if !row.usage.is_empty() {
                w::subtle(ui, &row.usage, "label-12-mono");
            }
            if !row.task.is_empty() {
                w::subtle(ui, &row.task, "label-12");
            }
            ui.add_space(4.0);
            w::subtle(ui, "Click to open the agent", "label-12");
        });
        resp.clicked()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, summary: &str, input: &str, done: bool) -> Item {
        Item::Tool { id: "t".into(), name: name.into(), summary: summary.into(), input: input.into(), result: done.then(|| "ok".into()), is_error: false }
    }

    #[test]
    fn doing_reads_the_latest_step() {
        let root = "/work/app";
        let user = Item::User { text: "go".into(), files: vec![], at: 1, mentions: vec![], sender: String::new(), intent: String::new() };
        assert_eq!(doing(&[], root), "starting");
        assert_eq!(doing(&[user.clone()], root), "starting");
        assert_eq!(doing(&[user.clone(), Item::Thinking { text: "h".into() }], root), "thinking");
        assert_eq!(doing(&[user.clone(), tool("Edit", "/work/app/src/chat.rs", "{}", false)], root), "editing src/chat.rs");
        assert_eq!(doing(&[tool("Edit", "/elsewhere/x/src/chat.rs", "{}", true)], root), "editing src/chat.rs");
        assert_eq!(doing(&[tool("Edit", "update src/api.rs", "", false)], root), "editing src/api.rs");
        assert_eq!(doing(&[tool("Read", "/work/app/README.md", "{}", false)], root), "reading README.md");
        assert_eq!(doing(&[tool("Bash", "cd /work/app && cargo test api::", "{}", false)], root), "running tests");
        assert_eq!(doing(&[tool("Bash", "~/.cache/harbor-rel/build.sh check", "{}", false)], root), "building");
        assert_eq!(doing(&[tool("Shell", "git push origin main", "", false)], root), "pushing");
        assert_eq!(doing(&[tool("Bash", "RUST_LOG=1 npm install left-pad", "{}", false)], root), "running npm install");
        assert_eq!(doing(&[tool("mcp__harbor__send_message", "", r#"{"to":"lead","text":"hi"}"#, false)], root), "messaging lead");
        assert_eq!(doing(&[tool("mcp__github__get_pr", "", "{}", false)], root), "github · get_pr");
        assert_eq!(doing(&[tool("WebFetch", "https://docs.rs/egui/latest", "{}", false)], root), "reading docs.rs");
        assert_eq!(doing(&[tool("Grep", "fn main", "{}", false), Item::Text { text: "Done: all good".into(), at: 2 }], root), "writing");
        // An earlier turn's steps don't count.
        assert_eq!(doing(&[tool("Grep", "x", "{}", true), user], root), "starting");
    }

    #[test]
    fn report_line_takes_the_first_sentence() {
        assert_eq!(report_line("api", "Added tests for the parser. Also fixed a typo.\n\nDetails…"), "api finished: Added tests for the parser");
        assert_eq!(report_line("ui", "## Summary\n\n**Done**: moved the strip above the composer"), "ui finished: Done: moved the strip above the composer");
        assert_eq!(report_line("ui", "(no text reply)"), "ui finished");
        assert_eq!(report_line("db", "Error: the build failed"), "db failed: the build failed");
        let long = "word ".repeat(60);
        let line = report_line("x", &long);
        assert!(line.ends_with('…') && line.chars().count() <= REPORT_MAX + "x finished: ".len());
    }

    #[test]
    fn elapsed_and_titles() {
        assert_eq!(short_elapsed(40), "40s");
        assert_eq!(short_elapsed(150), "2m");
        assert_eq!(short_elapsed(3900), "1h 5m");
        assert_eq!(title(1, 0), "1 agent working");
        assert_eq!(title(3, 2), "3 agents working  ·  2 queued");
    }

    #[test]
    fn every_provider_has_its_logo_file() {
        for k in [Kind::Claude, Kind::Codex, Kind::Cursor, Kind::Grok, Kind::Gemini, Kind::Meta, Kind::OpenCode] {
            let (f, _) = logo(k);
            assert!(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/logos").join(f).exists(), "{f}");
        }
    }
}
