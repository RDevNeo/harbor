//! `@` and `#` tags in the composer, as in T3 Code and Codex: typing `@` at the start of
//! a word opens a menu above the composer with the project's files (git's tracked and
//! untracked-not-ignored ones; a folder without Git, what's on disk), `#` its GitHub issues and pull requests, fuzzy-matched as
//! you type. Picking one writes `@path` or `#123` into the text, drawn as a highlighted
//! token; when the message goes out the agent gets a short list of what was tagged (the
//! file's full path, the issue's title and URL) after it (`App::tags_prompt`).
//!
//! The phone asks the same lists, ranked here, with `GET /v1/chats/{id}/tags`
//! (android/PROTOCOL.md).

use crate::widgets::Tip as _;
use crate::app::App;
use crate::icons as ic;
use crate::slash;
use crate::theme::{self, RADIUS_MD};
use crate::widgets as w;
use eframe::egui::{self, Align2, Color32, CornerRadius, FontId, Id, Key, Modifiers, Rect, ScrollArea, Sense, Ui, Vec2, pos2};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A project's files are listed again when the menu opens after this long.
const FILES_STALE: Duration = Duration::from_secs(20);
/// Its issues and pull requests are asked again after this long.
const REFS_STALE: Duration = Duration::from_secs(120);
/// More files than this aren't listed (a huge tree, or a home folder).
const MAX_FILES: usize = 50_000;
/// Rows the menu (and the phone's list) shows at most.
pub const MAX_ROWS: usize = 50;
const ROW_H: f32 = 32.0;
const MENU_MAX_H: f32 = 288.0;

// ---------------------------------------------------------------- the word

/// The `@word` or `#word` being typed: its first char, where it is (in chars), and the
/// chars after the trigger up to the cursor.
#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub trigger: char,
    pub start: usize,
    pub end: usize,
    pub query: String,
}

impl Word {
    /// As slash.rs's word, for its `replace`.
    fn slash(&self) -> slash::Word {
        slash::Word { start: self.start, end: self.end, query: self.query.clone(), first: false }
    }
}

const OPENERS: &str = "([{\"'`";
/// What may end a tag written in a sentence.
pub(crate) const PUNCT: &[char] = &[',', '.', ';', ':', '!', '?', ')', ']', '}', '"', '\'', '`'];

/// Whether a tag may start after `prev` (the char before its trigger): at the start, after
/// a space, or an opening bracket or quote (not inside an email address or `a#b`).
pub(crate) fn opens(prev: Option<char>) -> bool {
    prev.is_none_or(|c| c.is_whitespace() || OPENERS.contains(c))
}

/// The `@word` or `#word` at char `cursor` of `text`, if the cursor is in one.
pub fn word(text: &str, cursor: usize) -> Option<Word> {
    let chars: Vec<char> = text.chars().collect();
    let cursor = cursor.min(chars.len());
    let mut start = (0..cursor).rev().find(|&i| chars[i].is_whitespace()).map_or(0, |i| i + 1);
    // `(@x` and `"#4`: the bracket or quote isn't part of it.
    while start < cursor && OPENERS.contains(chars[start]) {
        start += 1;
    }
    let trigger = *chars.get(start)?;
    if !matches!(trigger, '@' | '#') || start == cursor {
        return None;
    }
    let query: String = chars[start + 1..cursor].iter().collect();
    // `##` (a heading) and `@@` are not tags.
    if query.starts_with(trigger) {
        return None;
    }
    let end = (cursor..chars.len()).find(|&i| chars[i].is_whitespace()).unwrap_or(chars.len());
    Some(Word { trigger, start, end, query })
}

/// The tags written in a message: `@path`s and `#numbers`, each once, in order.
pub fn tagged(text: &str) -> (Vec<String>, Vec<u64>) {
    let (mut files, mut numbers) = (vec![], vec![]);
    for (i, len) in tokens(text) {
        let body = &text[i + 1..i + len];
        if text[i..].starts_with('@') {
            if !files.iter().any(|f| f == body) {
                files.push(body.to_string());
            }
        } else if let Ok(n) = body.parse::<u64>() {
            if !numbers.contains(&n) {
                numbers.push(n);
            }
        }
    }
    (files, numbers)
}

/// The tag tokens of `text`: (byte offset, byte length) of each `@x` and `#123`, without
/// the punctuation after them, as the composer highlights them.
pub fn tokens(text: &str) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut prev: Option<char> = None;
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if matches!(c, '@' | '#') && opens(prev) {
            let len = text[i..].find(char::is_whitespace).unwrap_or(text.len() - i);
            let body = text[i + 1..i + len].trim_end_matches(PUNCT);
            let ok = !body.is_empty() && if c == '@' { !body.starts_with('@') } else { body.bytes().all(|b| b.is_ascii_digit()) };
            if ok {
                out.push((i, 1 + body.len()));
                while it.peek().is_some_and(|(j, _)| *j < i + len) {
                    prev = it.next().map(|x| x.1);
                }
                continue;
            }
        }
        prev = Some(c);
    }
    out
}

// ---------------------------------------------------------------- ranking

/// Its letters in order in `hay`: how many were skipped between them (the ones before
/// the first count half), or None.
fn in_order(hay: &str, q: &str) -> Option<u32> {
    let mut rest = hay.chars();
    let (mut gaps, mut lead, mut first) = (0u32, 0u32, true);
    for c in q.chars() {
        loop {
            match rest.next() {
                Some(x) if x == c => break,
                Some(_) if first => lead += 1,
                Some(_) => gaps += 1,
                None => return None,
            }
        }
        first = false;
    }
    Some(gaps + lead / 2)
}

/// Whether `q` starts a word of `hay` (after `-`, `_`, `.`, `/` or a space).
fn at_boundary(hay: &str, q: &str) -> bool {
    hay.match_indices(q).any(|(i, _)| i == 0 || hay[..i].ends_with(['-', '_', '.', '/', ' ']))
}

/// How well `query` matches a name or title (lower is better): exactly, as a prefix, at a
/// word boundary, anywhere, its letters in order (fewer skipped first). The palette's ranking.
pub fn text_score(hay: &str, query: &str) -> Option<u32> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return Some(0);
    }
    let h = hay.to_lowercase();
    if h == q {
        Some(0)
    } else if h.starts_with(&q) {
        Some(10)
    } else if at_boundary(&h, &q) {
        Some(20)
    } else if h.contains(&q) {
        Some(30)
    } else {
        in_order(&h, &q).map(|g| 100 + g)
    }
}

/// How well `query` matches a project file's path (lower is better): its name exactly,
/// then as a prefix, at a word boundary, anywhere; then a folder's name, the path, and
/// the letters in order (in the name before the path). A query with `/` matches the path.
pub fn file_score(path: &str, query: &str) -> Option<u32> {
    if query.is_empty() {
        return Some(path.matches('/').count() as u32);
    }
    let q = query.to_lowercase();
    let p = path.to_lowercase();
    let name = p.rsplit('/').next().unwrap_or(&p);
    let stem = name.split('.').next().unwrap_or(name);
    if q.contains('/') {
        return if p == q {
            Some(0)
        } else if p.ends_with(&q) && p[..p.len() - q.len()].ends_with('/') {
            Some(5)
        } else if p.starts_with(&q) {
            Some(10)
        } else if at_boundary(&p, &q) {
            Some(15)
        } else if p.contains(&q) {
            Some(20)
        } else {
            in_order(&p, &q).map(|g| 200 + g)
        };
    }
    if name == q {
        Some(0)
    } else if stem == q {
        Some(1)
    } else if name.starts_with(&q) {
        Some(10)
    } else if at_boundary(name, &q) {
        Some(20)
    } else if name.contains(&q) {
        Some(30)
    } else if at_boundary(&p, &q) {
        Some(40)
    } else if p.contains(&q) {
        Some(50)
    } else if let Some(g) = in_order(name, &q) {
        Some(100 + g)
    } else {
        in_order(&p, &q).map(|g| 300 + g)
    }
}

/// The files for `query`, best first (shorter paths first among equals), at most `limit`.
pub fn rank_files<'a>(files: &'a [String], query: &str, limit: usize) -> Vec<&'a str> {
    let mut v: Vec<(u32, &str)> = files.iter().filter_map(|f| Some((file_score(f, query)?, f.as_str()))).collect();
    v.sort_by(|a, b| (a.0, a.1.len(), a.1).cmp(&(b.0, b.1.len(), b.1)));
    v.into_iter().take(limit).map(|x| x.1).collect()
}

/// An issue or a pull request of the project's GitHub repo.
#[derive(Clone, Debug, PartialEq)]
pub struct Ref {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub pr: bool,
    /// open, closed, merged or draft.
    pub state: String,
    pub updated: i64,
}

impl Ref {
    fn open(&self) -> bool {
        matches!(self.state.as_str(), "open" | "draft")
    }

    /// How the agent is told about it.
    fn line(&self) -> String {
        let what = if self.pr { "pull request" } else { "issue" };
        format!("#{}: GitHub {what} \"{}\" ({}), {}", self.number, self.title, self.state, self.url)
    }
}

/// How well `query` matches an issue or PR (lower is better): its number (exactly, then
/// as a prefix), then its title (a word's start, anywhere, its letters in order). Closed
/// ones come after open ones.
pub fn ref_score(r: &Ref, query: &str) -> Option<u32> {
    let closed = if r.open() { 0 } else { 1 };
    let q = query.trim_start_matches('#').to_lowercase();
    if q.is_empty() {
        return Some(closed);
    }
    let n = r.number.to_string();
    let t = r.title.to_lowercase();
    let s = if n == q {
        0
    } else if n.starts_with(&q) {
        10 + (n.len() - q.len()) as u32
    } else if t.starts_with(&q) {
        20
    } else if at_boundary(&t, &q) {
        24
    } else if t.contains(&q) {
        30
    } else {
        100 + in_order(&t, &q)?
    };
    Some(s * 2 + closed)
}

/// The issues and PRs for `query`, best first (most recently updated among equals).
pub fn rank_refs<'a>(refs: &'a [Ref], query: &str, limit: usize) -> Vec<&'a Ref> {
    let mut v: Vec<(u32, &Ref)> = refs.iter().filter_map(|r| Some((ref_score(r, query)?, r))).collect();
    v.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.updated.cmp(&a.1.updated)).then(b.1.number.cmp(&a.1.number)));
    v.into_iter().take(limit).map(|x| x.1).collect()
}

// ---------------------------------------------------------------- file types

/// A file's icon kind by its extension (the phone maps the same names): ts, tsx, js, rs,
/// json, md, image, shell, code or file.
pub fn file_kind(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    let ext = name.rsplit_once('.').map(|x| x.1).unwrap_or("");
    match ext {
        "ts" | "mts" | "cts" => "ts",
        "tsx" | "jsx" => "tsx",
        "js" | "mjs" | "cjs" => "js",
        "rs" => "rs",
        "json" | "jsonc" | "toml" | "yaml" | "yml" | "lock" => "json",
        "md" | "mdx" | "txt" | "rst" => "md",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" => "image",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "py" | "go" | "java" | "kt" | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "swift" | "rb" | "php" | "lua" | "luau" | "css" | "scss" | "html" | "vue" | "svelte" | "sql" | "zig" | "dart" => "code",
        _ => "file",
    }
}

/// A file kind's glyph and colour.
pub fn file_icon(kind: &str, t: &theme::Tokens) -> (&'static str, Color32) {
    match kind {
        "ts" | "tsx" => (ic::FILE_CODE, t.blue(700)),
        "js" => (ic::FILE_CODE, t.amber(700)),
        "rs" => (ic::FILE_CODE, t.red(700)),
        "json" => (ic::FILE_BRACES, t.amber(700)),
        "md" => (ic::FILE_TEXT, t.blue(700)),
        "image" => (ic::FILE_IMAGE, t.green(700)),
        "shell" => (ic::TERMINAL, t.green(700)),
        "code" => (ic::FILE_CODE, t.subtle()),
        _ => (ic::FILE, t.subtle()),
    }
}

/// The glyph and colour of an issue or PR by its state (as the Issues and PR pages draw them).
fn ref_icon(r: &Ref, t: &theme::Tokens) -> (&'static str, Color32) {
    match (r.pr, r.state.as_str()) {
        (true, "merged") => (ic::GIT_MERGE, t.blue(700)),
        (true, "draft") => (ic::PR_DRAFT, t.subtle()),
        (true, "closed") => (ic::PR_CLOSED, t.red(700)),
        (true, _) => (ic::PR_OPEN, t.green(700)),
        (false, "open") => (ic::CIRCLE_DOT, t.green(700)),
        (false, _) => (ic::CIRCLE_CHECK, t.blue(700)),
    }
}

/// `path` split as the menu shows it: file name, then its folder ("" at the top).
fn split(path: &str) -> (&str, &str) {
    match path.rsplit_once('/') {
        Some((dir, name)) => (name, dir),
        None => (path, ""),
    }
}

// ---------------------------------------------------------------- listing

/// A project's files: git's tracked and untracked-not-ignored ones; in a folder without Git,
/// what's on disk (`walk`). None when it can't be read.
fn list_files(cwd: &Path) -> Option<Vec<String>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let Some(out) = out.ok().filter(|o| o.status.success()) else { return walk(cwd) };
    let mut v: Vec<String> = out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
    v.sort();
    v.dedup();
    v.truncate(MAX_FILES);
    Some(v)
}

/// Folders a plain project's listing skips, besides hidden ones: dependencies and builds.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "__pycache__", "venv"];

/// A folder's files without Git, breadth first (shallow ones first when it's huge): hidden
/// entries, symlinks and `SKIP_DIRS` left out, paths relative to `cwd` with `/`.
fn walk(cwd: &Path) -> Option<Vec<String>> {
    let mut v = vec![];
    let mut dirs = std::collections::VecDeque::from([PathBuf::new()]);
    std::fs::read_dir(cwd).ok()?;
    while let Some(rel) = dirs.pop_front() {
        let Ok(rd) = std::fs::read_dir(cwd.join(&rel)) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            if name.starts_with('.') || ft.is_symlink() {
                continue;
            }
            let path = rel.join(&name);
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    dirs.push_back(path);
                }
            } else if ft.is_file() {
                v.push(path.to_string_lossy().replace('\\', "/"));
                if v.len() >= MAX_FILES {
                    dirs.clear();
                    break;
                }
            }
        }
    }
    v.sort();
    Some(v)
}

/// The repo's latest issues and pull requests (100 of each), most recently updated first.
fn fetch_refs(repo: &str) -> Option<Vec<Ref>> {
    let (owner, name) = repo.split_once('/')?;
    let clean = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect::<String>();
    let q = format!(
        "query {{ repository(owner: \"{}\", name: \"{}\") {{ \
         issues(first: 100, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ number title url state updatedAt }} }} \
         pullRequests(first: 100, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ number title url state isDraft updatedAt }} }} }} }}",
        clean(owner),
        clean(name)
    );
    let v = crate::prs::graphql(&q, "issues and pull requests").ok()?;
    Some(parse_refs(&v))
}

fn parse_refs(v: &Value) -> Vec<Ref> {
    let r = &v["data"]["repository"];
    let mut out = vec![];
    for (key, pr) in [("issues", false), ("pullRequests", true)] {
        for n in r[key]["nodes"].as_array().into_iter().flatten() {
            let Some(number) = n["number"].as_u64() else { continue };
            let state = n["state"].as_str().unwrap_or("").to_lowercase();
            let state = if pr && state == "open" && n["isDraft"] == true { "draft".to_string() } else { state };
            out.push(Ref {
                number,
                title: n["title"].as_str().unwrap_or("").to_string(),
                url: n["url"].as_str().unwrap_or("").to_string(),
                pr,
                state,
                updated: crate::prs::iso_secs(n["updatedAt"].as_str().unwrap_or("")).unwrap_or(0),
            });
        }
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    out
}

/// A list being kept: when it was asked, and the last answer.
struct Cached<T> {
    at: Instant,
    items: Option<Arc<Vec<T>>>,
}

type Lists<K, T> = Arc<Mutex<HashMap<K, Cached<T>>>>;

/// Asks `load` again on a thread when `key`'s list is older than `stale`; the old list
/// stays meanwhile.
fn refresh<K, T>(lists: &Lists<K, T>, key: K, stale: Duration, ctx: &egui::Context, load: impl FnOnce() -> Option<Vec<T>> + Send + 'static)
where
    K: std::hash::Hash + Eq + Clone + Send + 'static,
    T: Send + Sync + 'static,
{
    {
        let mut m = lists.lock().unwrap();
        if m.get(&key).is_some_and(|c| c.at.elapsed() < stale) {
            return;
        }
        let old = m.remove(&key).and_then(|c| c.items);
        m.insert(key.clone(), Cached { at: Instant::now(), items: old });
    }
    let (lists, ctx) = (lists.clone(), ctx.clone());
    std::thread::spawn(move || {
        let found = load().unwrap_or_default();
        if let Some(c) = lists.lock().unwrap().get_mut(&key) {
            c.items = Some(Arc::new(found));
        }
        ctx.request_repaint();
    });
}

fn current<K: std::hash::Hash + Eq, T>(lists: &Lists<K, T>, key: &K) -> (Option<Arc<Vec<T>>>, bool) {
    let m = lists.lock().unwrap();
    match m.get(key) {
        Some(c) => (c.items.clone(), c.items.is_none()),
        None => (None, true),
    }
}

// ---------------------------------------------------------------- state

#[derive(Default)]
pub struct State {
    /// The composer whose menu showed last frame.
    pub open: Option<i64>,
    sel: usize,
    query: String,
    scroll: bool,
    /// Esc closed the menu for the word starting here (composer, char).
    dismissed: Option<(i64, usize)>,
    files: Lists<PathBuf, String>,
    refs: Lists<String, Ref>,
}

/// One row of the menu.
#[derive(Clone, Debug)]
enum Row {
    File(String),
    Ref(Ref),
}

impl Row {
    /// What picking it writes.
    fn insert(&self) -> String {
        match self {
            Row::File(p) => format!("@{p}"),
            Row::Ref(r) => format!("#{}", r.number),
        }
    }

    /// As the phone gets it.
    fn json(&self) -> Value {
        match self {
            Row::File(p) => {
                let (name, dir) = split(p);
                json!({ "kind": "file", "insert": self.insert(), "path": p, "name": name, "dir": dir, "icon": file_kind(p) })
            }
            Row::Ref(r) => json!({
                "kind": if r.pr { "pr" } else { "issue" }, "insert": self.insert(), "number": r.number,
                "title": r.title, "state": r.state, "url": r.url,
            }),
        }
    }
}

impl App {
    /// The GitHub repo (owner/name) of a project, when its git status is known.
    fn tags_repo(&self, repo: Option<i64>) -> Option<String> {
        let remote = self.git.get(&repo?)?.as_ref()?.remote.clone()?;
        crate::prs::github_repo(&remote)
    }

    /// The rows for a word in a project's composer; true while the list is still coming.
    fn tags_rows(&mut self, repo: Option<i64>, trigger: char, query: &str, ctx: &egui::Context, ask: bool) -> (Vec<Row>, bool) {
        match trigger {
            '@' => {
                // No project: the chat runs in the home folder, which isn't listed.
                if repo.and_then(|r| self.repo(r)).is_none() {
                    return (vec![], false);
                }
                let cwd = self.cwd_of(repo);
                if ask {
                    let dir = cwd.clone();
                    refresh(&self.tags.files, cwd.clone(), FILES_STALE, ctx, move || list_files(&dir));
                }
                let (files, pending) = current(&self.tags.files, &cwd);
                let rows = files.map(|f| rank_files(&f, query, MAX_ROWS).into_iter().map(|p| Row::File(p.to_string())).collect()).unwrap_or_default();
                (rows, pending)
            }
            _ => {
                let Some(gh) = self.tags_repo(repo) else { return (vec![], false) };
                if ask {
                    let r = gh.clone();
                    refresh(&self.tags.refs, gh.clone(), REFS_STALE, ctx, move || fetch_refs(&r));
                }
                let (refs, pending) = current(&self.tags.refs, &gh);
                let rows = refs.map(|r| rank_refs(&r, query, MAX_ROWS).into_iter().map(|r| Row::Ref(r.clone())).collect()).unwrap_or_default();
                (rows, pending)
            }
        }
    }

    /// `GET /v1/chats/{id}/tags?trigger=@|#&q=…`: the composer menu's rows for a chat's
    /// project, ranked as the desktop ranks them; `pending` while the list is being read
    /// (ask again in a moment).
    pub fn api_tags(&mut self, chat: i64, trigger: &str, query: &str, ctx: &egui::Context) -> Value {
        let repo = self.chat(chat).and_then(|c| c.repo_id);
        self.api_tags_in(repo, trigger, query, ctx)
    }

    /// A project named on the wire (`project=`): its id here, or its folder (as phones that
    /// move between PCs know it). None for none or an unknown one.
    pub fn project_ref(&self, r: &str) -> Option<i64> {
        match r.parse::<i64>() {
            Ok(id) => self.repo(id).map(|r| r.id),
            Err(_) => self.repos.iter().find(|x| x.path.to_string_lossy() == r).map(|x| x.id),
        }
    }

    /// `GET /v1/tags?project=…&trigger=…&q=…`: the same rows for a new chat's composer (no
    /// chat yet), by its project.
    pub fn api_tags_in(&mut self, repo: Option<i64>, trigger: &str, query: &str, ctx: &egui::Context) -> Value {
        let t = if trigger.starts_with('#') { '#' } else { '@' };
        let (rows, pending) = self.tags_rows(repo, t, query, ctx, true);
        json!({ "items": rows.iter().map(Row::json).collect::<Vec<_>>(), "pending": pending })
    }

    /// What the agent gets after the user's text: the files and the issues or PRs tagged
    /// in it, with their full path or title and URL (nothing when there are none).
    pub fn tags_prompt(&self, chat_id: i64, text: &str) -> String {
        if !text.contains(['@', '#']) {
            return String::new();
        }
        let (files, numbers) = tagged(text);
        let repo = self.chat(chat_id).and_then(|c| c.repo_id);
        let mut lines = vec![];
        if repo.is_some() {
            let cwd = self.chat(chat_id).map(|c| self.chat_cwd(c)).unwrap_or_else(|| self.cwd_of(repo));
            for f in &files {
                let p = cwd.join(f);
                if !f.is_empty() && !f.starts_with('/') && !f.contains("..") && p.exists() {
                    let what = if p.is_dir() { "a folder" } else { "a file" };
                    lines.push(format!("@{f}: {what} in the project, {}", p.display()));
                }
            }
        }
        if !numbers.is_empty() {
            if let Some(gh) = self.tags_repo(repo) {
                let (refs, _) = current(&self.tags.refs, &gh);
                for n in numbers {
                    match refs.as_ref().and_then(|r| r.iter().find(|r| r.number == n)) {
                        Some(r) => lines.push(r.line()),
                        // Not in the latest 100: GitHub sends /issues/N on to a PR too.
                        None if refs.is_some() => lines.push(format!("#{n}: GitHub issue or pull request of {gh}, https://github.com/{gh}/issues/{n}")),
                        None => {}
                    }
                }
            }
        }
        if lines.is_empty() {
            return String::new();
        }
        format!("\n\n[Tagged in this message:\n- {}]", lines.join("\n- "))
    }

    /// Before the composer's text field: the open menu takes its keys (arrows, Enter and
    /// Tab to pick, Esc to close).
    pub fn tags_keys(&mut self, ui: &mut Ui, key: i64, cid: Id, draft: &mut String) {
        if self.tags.open != Some(key) {
            return;
        }
        let Some(w) = cursor_word(ui.ctx(), cid, draft) else { return };
        let (rows, _) = self.tags_rows(self.current_repo(), w.trigger, &w.query, ui.ctx(), false);
        if rows.is_empty() {
            return;
        }
        let none = Modifiers::NONE;
        let (up, down, accept, esc) = ui.input_mut(|i| {
            let accept = i.consume_key(none, Key::Enter) | i.consume_key(none, Key::Tab);
            (i.consume_key(none, Key::ArrowUp), i.consume_key(none, Key::ArrowDown), accept, i.consume_key(none, Key::Escape))
        });
        let n = rows.len();
        if up || down {
            self.tags.sel = if down { (self.tags.sel + 1) % n } else { (self.tags.sel + n - 1) % n };
            self.tags.scroll = true;
        }
        if esc {
            self.tags.dismissed = Some((key, w.start));
            self.tags.open = None;
        }
        if accept {
            let r = rows[self.tags.sel.min(n - 1)].clone();
            self.tags_accept(ui.ctx(), cid, draft, &w, &r);
        }
    }

    fn tags_accept(&mut self, ctx: &egui::Context, cid: Id, draft: &mut String, w: &Word, r: &Row) {
        let (text, cursor) = slash::replace(draft, &w.slash(), &r.insert());
        *draft = text;
        crate::usertext::picked(ctx, cid, &r.insert());
        let mut state = egui::text_edit::TextEditState::load(ctx, cid).unwrap_or_default();
        state.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(cursor))));
        state.store(ctx, cid);
        ctx.memory_mut(|m| m.request_focus(cid));
        self.tags.open = None;
    }

    /// After the composer (drawn in `frame`): the menu above it for the `@word` or `#word`
    /// at the cursor.
    pub fn tags_menu(&mut self, ui: &mut Ui, key: i64, cid: Id, draft: &mut String, focused: bool, frame: Rect) {
        let ctx = ui.ctx().clone();
        let w = if focused && self.popup.is_none() && self.dialog.is_none() { cursor_word(&ctx, cid, draft) } else { None };
        if self.tags.dismissed.is_some_and(|(k, start)| k == key && w.as_ref().map(|w| w.start) != Some(start)) {
            self.tags.dismissed = None;
        }
        let Some(w) = w.filter(|w| self.tags.dismissed != Some((key, w.start))) else {
            self.tags.open = None;
            return;
        };
        let opening = self.tags.open != Some(key);
        if opening || self.tags.query != w.query {
            self.tags.query = w.query.clone();
            self.tags.sel = 0;
        }
        let (rows, pending) = self.tags_rows(self.current_repo(), w.trigger, &w.query, &ctx, opening);
        if rows.is_empty() && !(pending && w.query.is_empty()) {
            self.tags.open = None;
            return;
        }
        self.tags.sel = self.tags.sel.min(rows.len().saturating_sub(1));
        self.tags.open = Some(key);
        ui.memory_mut(|m| m.set_focus_lock_filter(cid, egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true }));
        let tk = self.theme.t;
        let (sel, scroll) = (self.tags.sel, std::mem::take(&mut self.tags.scroll));
        let (moved, pressed) = ctx.input(|i| (i.pointer.delta() != Vec2::ZERO, i.pointer.primary_pressed()));
        let mut hover = None;
        let mut pick = None;
        let max_h = MENU_MAX_H.min(frame.top() - ctx.content_rect().top() - 24.0).max(ROW_H * 3.0);
        egui::Area::new(Id::NULL.with(("tags-menu", key)))
            .order(egui::Order::Foreground)
            .pivot(Align2::LEFT_BOTTOM)
            .fixed_pos(frame.left_top() - Vec2::new(0.0, 6.0))
            .constrain(true)
            .show(&ctx, |ui| {
                w::popover_frame(&tk).show(ui, |ui| {
                    ui.set_width(frame.width() - 14.0);
                    if rows.is_empty() {
                        let what = if w.trigger == '@' { "Listing the project's files…" } else { "Loading issues and pull requests…" };
                        let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_H), Sense::hover());
                        ui.painter().text(pos2(rect.left() + 10.0, rect.center().y), Align2::LEFT_CENTER, what, FontId::proportional(12.5), tk.subtle());
                        return;
                    }
                    ScrollArea::vertical().max_height(max_h).auto_shrink([false, true]).show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 0.0;
                        for (i, r) in rows.iter().enumerate() {
                            let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_H), Sense::hover());
                            if ui.rect_contains_pointer(rect) {
                                if moved {
                                    hover = Some(i);
                                }
                                if pressed {
                                    pick = Some(i);
                                }
                            }
                            if i == sel && scroll {
                                ui.scroll_to_rect(rect, None);
                            }
                            row(ui, rect, r, i == sel);
                            match r {
                                Row::File(p) => resp.tip(p),
                                Row::Ref(x) => resp.tip(format!("#{} {}\n{}", x.number, x.title, x.url)),
                            };
                        }
                    });
                });
            });
        if let Some(i) = hover {
            self.tags.sel = i;
        }
        if let Some(r) = pick.and_then(|i| rows.get(i)).cloned() {
            self.tags_accept(&ctx, cid, draft, &w, &r);
        }
    }
}

/// The tag word at the composer's cursor.
fn cursor_word(ctx: &egui::Context, cid: Id, draft: &str) -> Option<Word> {
    let state = egui::text_edit::TextEditState::load(ctx, cid)?;
    word(draft, state.cursor.char_range()?.primary.index.0)
}

/// One menu row: a file's type icon, name and dimmed folder; an issue's or PR's state
/// icon, number and title.
fn row(ui: &Ui, rect: Rect, r: &Row, selected: bool) {
    let t = w::tokens(ui);
    let p = ui.painter();
    if selected {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.accent());
    }
    let (icon, color, name, rest) = match r {
        Row::File(path) => {
            let (icon, color) = file_icon(file_kind(path), &t);
            let (name, dir) = split(path);
            (icon, color, name.to_string(), dir.to_string())
        }
        Row::Ref(x) => {
            let (icon, color) = ref_icon(x, &t);
            (icon, color, format!("#{}", x.number), x.title.clone())
        }
    };
    ic::glyph(p, pos2(rect.left() + 18.0, rect.center().y), icon, 14.0, color);
    let x = rect.left() + 32.0;
    let room = rect.right() - 10.0 - x;
    let name = w::truncated(ui, &name, FontId::new(13.0, theme::medium()), t.fg(), (room * 0.6).max(40.0));
    let dx = x + name.size().x + 10.0;
    p.galley(pos2(x, rect.center().y - name.size().y / 2.0), name, t.fg());
    let left = rect.right() - 10.0 - dx;
    if left > 30.0 && !rest.is_empty() {
        let d = w::truncated(ui, &rest, FontId::proportional(12.5), t.subtle(), left);
        p.galley(pos2(dx, rect.center().y - d.size().y / 2.0), d, t.subtle());
    }
}

/// The composer's text laid out with its tags, `/command`s and mentioned chats' titles
/// (`titles`: title, global id) highlighted, the runs its message shows (usertext.rs).
pub fn layout(ui: &Ui, text: &str, wrap: f32, font: FontId, titles: &[(String, String)]) -> Arc<egui::Galley> {
    let t = w::tokens(ui);
    let color = ui.visuals().override_text_color.unwrap_or_else(|| ui.visuals().widgets.inactive.text_color());
    let plain = egui::TextFormat { font_id: font.clone(), color, ..Default::default() };
    let tag = egui::TextFormat { font_id: font, color: t.blue(800), background: t.blue(200), ..Default::default() };
    let mut job = egui::text::LayoutJob::default();
    let mut at = 0;
    for (a, z, _) in crate::usertext::runs(text, titles) {
        job.append(&text[at..a], 0.0, plain.clone());
        job.append(&text[a..z], 0.0, tag.clone());
        at = z;
    }
    job.append(&text[at..], 0.0, plain);
    job.wrap.max_width = wrap;
    ui.fonts_mut(|f| f.layout_job(job))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(number: u64, title: &str, pr: bool, state: &str, updated: i64) -> Ref {
        Ref { number, title: title.into(), url: format!("https://github.com/o/r/{}/{number}", if pr { "pull" } else { "issues" }), pr, state: state.into(), updated }
    }

    #[test]
    fn finds_the_word_at_the_cursor() {
        assert_eq!(word("@src", 4), Some(Word { trigger: '@', start: 0, end: 4, query: "src".into() }));
        assert_eq!(word("look at @ch now", 11), Some(Word { trigger: '@', start: 8, end: 11, query: "ch".into() }));
        assert_eq!(word("fix #12", 7).map(|w| (w.trigger, w.query)), Some(('#', "12".into())));
        assert_eq!(word("(#4", 3).map(|w| w.start), Some(1));
        assert_eq!(word("@", 1).map(|w| w.query), Some(String::new()));
        // Not in an email address, a heading's `##`, or after the word.
        assert_eq!(word("me@host", 7), None);
        assert_eq!(word("## Title", 2), None);
        assert_eq!(word("@a ", 3), None);
        assert_eq!(word("/cmd", 4), None);
    }

    #[test]
    fn finds_tags_in_a_message() {
        let text = "see @src/chat.rs, and #12 (also #12) or me@mail.com, @src/chat.rs again #x #7.";
        assert_eq!(tagged(text), (vec!["src/chat.rs".to_string()], vec![12, 7]));
        assert_eq!(tokens("a @b #3 c#4 #x"), vec![(2, 2), (5, 2)]);
        assert_eq!(tokens("é @ñ."), vec![(3, 3)]);
        assert_eq!(tokens("@app/(group)/page.tsx"), vec![(0, 21)]);
    }

    #[test]
    fn ranks_files() {
        let files: Vec<String> = [
            "src/components/creators/creator-profile-dialog.tsx",
            "src/components/creators/creator-card.tsx",
            "src/chat.rs",
            "src/chatbox/mod.rs",
            "docs/chat.md",
            "README.md",
            "src/app.rs",
            "android/src/dev/harbor/app/Chat.java",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let find = |q: &str| rank_files(&files, q, 10);
        // The name exactly, then by stem (shorter paths first), then as a prefix.
        assert_eq!(&find("chat.rs")[..1], ["src/chat.rs"]);
        assert_eq!(&find("chat")[..4], ["src/chat.rs", "docs/chat.md", "android/src/dev/harbor/app/Chat.java", "src/chatbox/mod.rs"]);
        // A word inside the name, and letters in order.
        assert_eq!(&find("profile")[..1], ["src/components/creators/creator-profile-dialog.tsx"]);
        assert_eq!(&find("cpd")[..1], ["src/components/creators/creator-profile-dialog.tsx"]);
        // A folder in the query matches the path.
        assert_eq!(&find("creators/card")[..1], ["src/components/creators/creator-card.tsx"]);
        assert!(find("zzz").is_empty());
        // Nothing typed: the shallowest first.
        assert_eq!(&find("")[..1], ["README.md"]);
        assert_eq!(rank_files(&files, "", 3).len(), 3);
    }

    #[test]
    fn ranks_issues_and_prs() {
        let refs = vec![
            r(12, "Composer tagging", false, "open", 5),
            r(120, "Fix tagging on phones", true, "open", 9),
            r(7, "Old tagging bug", false, "closed", 10),
            r(3, "Release notes", true, "merged", 1),
        ];
        let find = |q: &str| rank_refs(&refs, q, 10).iter().map(|r| r.number).collect::<Vec<_>>();
        assert_eq!(find("12"), [12, 120]);
        assert_eq!(find("#3"), [3]);
        // Title words; open before closed; the latest first among equals.
        assert_eq!(find("tag"), [120, 12, 7]);
        assert_eq!(find("rlnts"), [3]);
        assert_eq!(find(""), [120, 12, 7, 3]);
    }

    #[test]
    fn lists_a_folder_without_git() {
        let d = std::env::temp_dir().join(format!("harbor-tags-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        for f in ["notes.md", "docs/plan.md", "docs/old/a.txt", ".hidden/x", "node_modules/p/i.js", ".env"] {
            let p = d.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "x").unwrap();
        }
        let files = list_files(&d).unwrap();
        assert_eq!(files, vec!["docs/old/a.txt", "docs/plan.md", "notes.md"]);
        assert!(list_files(&d.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn file_kinds() {
        assert_eq!(file_kind("src/a.tsx"), "tsx");
        assert_eq!(file_kind("a.ts"), "ts");
        assert_eq!(file_kind("src/main.rs"), "rs");
        assert_eq!(file_kind("Cargo.toml"), "json");
        assert_eq!(file_kind("README.MD"), "md");
        assert_eq!(file_kind("Makefile"), "file");
        assert_eq!(file_kind("x.py"), "code");
    }

    #[test]
    fn reads_githubs_answer() {
        let v = json!({ "data": { "repository": {
            "issues": { "nodes": [{ "number": 4, "title": "Bug", "url": "u4", "state": "OPEN", "updatedAt": "2026-10-01T00:00:00Z" }] },
            "pullRequests": { "nodes": [
                { "number": 5, "title": "Fix", "url": "u5", "state": "OPEN", "isDraft": true, "updatedAt": "2026-10-02T00:00:00Z" },
                { "number": 6, "title": "Done", "url": "u6", "state": "MERGED", "isDraft": false, "updatedAt": "2026-09-01T00:00:00Z" }
            ] }
        } } });
        let v = parse_refs(&v);
        assert_eq!(v.iter().map(|r| (r.number, r.pr, r.state.as_str())).collect::<Vec<_>>(), [(5, true, "draft"), (4, false, "open"), (6, true, "merged")]);
        assert_eq!(v[1].line(), "#4: GitHub issue \"Bug\" (open), u4");
    }

    #[test]
    fn rows_for_the_phone() {
        let f = Row::File("src/components/x.tsx".into()).json();
        assert_eq!((f["insert"].as_str(), f["name"].as_str(), f["dir"].as_str(), f["icon"].as_str()), (Some("@src/components/x.tsx"), Some("x.tsx"), Some("src/components"), Some("tsx")));
        let i = Row::Ref(r(9, "T", true, "open", 0)).json();
        assert_eq!((i["kind"].as_str(), i["insert"].as_str(), i["number"].as_u64()), (Some("pr"), Some("#9"), Some(9)));
    }
}
