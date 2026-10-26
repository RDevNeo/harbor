//! Commit hashes in agents' replies become pills. A hex token (7–40 lowercase hex digits with a
//! digit and a letter, standing alone or alone in inline code) is checked against the chat's
//! repository; only real commits become pills, so a colour, a fingerprint or a UUID part stays
//! text. Fenced and indented code blocks, link texts and URLs are left alone: they are code or
//! already a link. Git runs on threads (a cache per directory and token), never on the UI's.
//!
//! The desktop draws them (chat.rs: `pills_md` + `paint_pills`), the phone gets them in the
//! block model (api.rs: spans with `commit`, the item's `commits`), and both open the same
//! card (`detail`, served as GET /v1/chats/{id}/commit/{sha}).

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A link target the desktop's markdown viewer hands back instead of opening.
pub const SCHEME: &str = "harbor-commit:";
/// How long "not a commit here" is believed: a copy's PC may fetch the commit later.
const FORGET_MISS: Duration = Duration::from_secs(300);
const GIT_LIMIT: Duration = Duration::from_secs(10);
/// A card lists at most this many files.
const MAX_FILES: usize = 300;

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Author date, Unix seconds.
    pub at: i64,
}

impl Commit {
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({ "sha": self.sha, "short": self.short, "subject": self.subject, "author": self.author, "at": self.at })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileStat {
    pub path: String,
    /// None: a binary file.
    pub adds: Option<u64>,
    pub dels: Option<u64>,
}

/// What the commit card shows.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Detail {
    pub commit: Commit,
    pub body: String,
    pub email: String,
    pub files: Vec<FileStat>,
    /// More files than `files` lists.
    pub more_files: usize,
    /// The commit on GitHub, when the repository has a GitHub remote.
    pub url: Option<String>,
}

impl Detail {
    pub fn json(&self) -> serde_json::Value {
        let mut v = self.commit.json();
        v["body"] = serde_json::json!(self.body);
        v["email"] = serde_json::json!(self.email);
        v["url"] = serde_json::json!(self.url);
        v["files"] = self.files.iter().map(|f| serde_json::json!({ "path": f.path, "adds": f.adds, "dels": f.dels })).collect();
        v["more_files"] = serde_json::json!(self.more_files);
        v
    }
}

// ------------------------------------------------------------------ detection

/// Whether a token looks like an abbreviated or full commit hash.
pub fn sha_like(tok: &str) -> bool {
    let b = tok.as_bytes();
    (7..=40).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
        && b.iter().any(u8::is_ascii_digit)
        && b.iter().any(|c| c.is_ascii_alphabetic())
}

/// The hash-like tokens of plain text, as byte ranges. A token must stand alone: not part of a
/// word, a path, a URL, a UUID (`-`), a colour (`#`), `0x…`, an e-mail or `key=value`.
pub fn tokens(text: &str) -> Vec<Range<usize>> {
    let b = text.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
            i += 1;
        }
        let tok = &text[start..i];
        let prev = start.checked_sub(1).map(|p| b[p]);
        let next = b.get(i).copied();
        let after = b.get(i + 1).copied();
        let glued_before = matches!(prev, Some(b'-' | b'#' | b'/' | b'.' | b'@' | b':' | b'$' | b'&' | b'=' | b'%' | b'\\' | b'~' | b'+'));
        // Sentence punctuation may follow ("in 7dfbd05."), a file extension or a port may not.
        let glued_after = matches!(next, Some(b'-' | b'/' | b'@' | b'\\' | b'+' | b'~')) || (matches!(next, Some(b'.' | b':')) && after.is_some_and(|a| a.is_ascii_alphanumeric()));
        if sha_like(tok) && !glued_before && !glued_after {
            out.push(start..i);
        }
    }
    out
}

/// Where a pill can go in markdown: a token in text (`code: false`), or a whole inline code span
/// whose content is just a token (`code: true`, the range includes the backticks).
#[derive(Debug, Clone, PartialEq)]
pub struct Site {
    pub range: Range<usize>,
    pub token: String,
    pub code: bool,
}

pub fn sites(md: &str) -> Vec<Site> {
    use pulldown_cmark::{Event as E, Options, Parser, Tag, TagEnd};
    if !maybe(md) {
        return vec![];
    }
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let (mut code_block, mut link) = (0u32, 0u32);
    let mut out = vec![];
    for (ev, r) in Parser::new_ext(md, opts).into_offset_iter() {
        match ev {
            E::Start(Tag::CodeBlock(_)) => code_block += 1,
            E::End(TagEnd::CodeBlock) => code_block = code_block.saturating_sub(1),
            E::Start(Tag::Link { .. } | Tag::Image { .. }) => link += 1,
            E::End(TagEnd::Link | TagEnd::Image) => link = link.saturating_sub(1),
            E::Text(_) if code_block == 0 && link == 0 => {
                let src = &md[r.clone()];
                for t in tokens(src) {
                    // Glued to what's just outside this event (`**`, `_`, a backslash)?
                    let (a, z) = (r.start + t.start, r.start + t.end);
                    out.push(Site { token: md[a..z].to_string(), range: a..z, code: false });
                }
            }
            E::Code(c) if code_block == 0 && link == 0 && sha_like(c.trim()) => out.push(Site { range: r, token: c.trim().to_string(), code: true }),
            _ => {}
        }
    }
    out
}

/// A quick look before parsing: any run of 7 hex digits at all?
pub fn maybe(text: &str) -> bool {
    let mut run = 0;
    for c in text.bytes() {
        if c.is_ascii_digit() || (b'a'..=b'f').contains(&c) {
            run += 1;
            if run >= 7 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// The distinct tokens of a reply, in order.
pub fn candidates(md: &str) -> Vec<String> {
    let mut v: Vec<String> = vec![];
    for s in sites(md) {
        if !v.contains(&s.token) {
            v.push(s.token);
        }
    }
    v
}

// ------------------------------------------------------------------ git

fn git(dir: &Path, args: &[&str], stdin: Option<&str>) -> Option<String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut cmd = Command::new("git");
    cmd.env("GIT_OPTIONAL_LOCKS", "0").args(["-c", "core.fsmonitor=false"]).arg("-C").arg(dir).args(args);
    let Some(input) = stdin else {
        let out = crate::git::output_within(&mut cmd, GIT_LIMIT).ok()?;
        return out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned());
    };
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut pipe = child.stdin.take()?;
    let input = input.to_string();
    let writer = std::thread::spawn(move || {
        let _ = pipe.write_all(input.as_bytes());
    });
    let out = child.wait_with_output().ok()?;
    let _ = writer.join();
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

const FORMAT: &str = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e";

fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            (f.len() >= 5 && f[0].len() >= 7).then(|| Commit { sha: f[0].into(), short: f[1].into(), subject: f[2].into(), author: f[3].into(), at: f[4].trim().parse().unwrap_or(0) })
        })
        .collect()
}

/// Which tokens name commits in `dir`'s repository (two git runs for any number of tokens).
/// Ambiguous prefixes and other objects (trees, blobs, tags of non-commits) are left out.
pub fn resolve(dir: &Path, tokens: &[String]) -> HashMap<String, Commit> {
    let mut found = HashMap::new();
    if tokens.is_empty() {
        return found;
    }
    // `^{commit}` peels an annotated tag; a short id that's also a branch name stays a commit id.
    let input: String = tokens.iter().map(|t| format!("{t}^{{commit}}\n")).collect();
    let Some(out) = git(dir, &["cat-file", "--batch-check=%(objectname) %(objecttype)"], Some(&input)) else { return found };
    let mut shas: Vec<(String, String)> = vec![];
    for (tok, line) in tokens.iter().zip(out.lines()) {
        let mut it = line.split_whitespace();
        if let (Some(sha), Some("commit")) = (it.next(), it.next()) {
            if sha.starts_with(tok.as_str()) {
                shas.push((tok.clone(), sha.to_string()));
            }
        }
    }
    if shas.is_empty() {
        return found;
    }
    let mut args = vec!["show", "-s", "--no-walk=unsorted", FORMAT];
    args.extend(shas.iter().map(|(_, s)| s.as_str()));
    let commits = git(dir, &args, None).map(|o| parse_log(&o)).unwrap_or_default();
    for (tok, sha) in shas {
        if let Some(c) = commits.iter().find(|c| c.sha == sha) {
            found.insert(tok, c.clone());
        }
    }
    found
}

/// The commit card: message, author, changed files, GitHub link.
pub fn detail(dir: &Path, sha: &str) -> Result<Detail, String> {
    if !sha_like(sha) {
        return Err("not a commit id".into());
    }
    let commit = resolve(dir, &[sha.to_string()]).remove(sha).ok_or_else(|| format!("{sha} isn't a commit in this project"))?;
    let body = git(dir, &["show", "-s", "--format=%b%x1f%ae", &commit.sha], None).unwrap_or_default();
    let (body, email) = body.split_once('\x1f').unwrap_or((&body, ""));
    // First parent only: a merge lists what it brought in.
    let stat = git(dir, &["show", "--numstat", "--format=", "--first-parent", "-m", "--no-renames", &commit.sha], None).unwrap_or_default();
    let mut files = numstat(&stat);
    let more_files = files.len().saturating_sub(MAX_FILES);
    files.truncate(MAX_FILES);
    let url = remotes(dir).iter().find_map(|u| github_base(u)).map(|b| format!("{b}/commit/{}", commit.sha));
    Ok(Detail { commit, body: body.trim().to_string(), email: email.trim().to_string(), files, more_files, url })
}

/// The commit's diff (prdetail.rs's diff model draws it).
pub fn diff(dir: &Path, sha: &str) -> Result<String, String> {
    if !sha_like(sha) {
        return Err("not a commit id".into());
    }
    git(dir, &["show", "--format=", "--first-parent", "-m", "--no-color", "--no-ext-diff", sha], None).ok_or_else(|| "git show failed".into())
}

fn numstat(out: &str) -> Vec<FileStat> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\t');
            let (a, d, p) = (it.next()?, it.next()?, it.next()?);
            Some(FileStat { path: p.to_string(), adds: a.parse().ok(), dels: d.parse().ok() })
        })
        .collect()
}

/// origin first, then the other remotes.
fn remotes(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = git(dir, &["remote", "get-url", "origin"], None).into_iter().map(|s| s.trim().to_string()).collect();
    for name in git(dir, &["remote"], None).unwrap_or_default().lines().filter(|n| *n != "origin") {
        if let Some(u) = git(dir, &["remote", "get-url", name], None) {
            v.push(u.trim().to_string());
        }
    }
    v
}

/// A remote's GitHub web address: `git@github.com:o/r.git`, `ssh://git@github.com[:22]/o/r`,
/// `https://[user[:token]@]github.com/o/r.git` and `git://github.com/o/r` all become
/// `https://github.com/o/r`. Other hosts: None.
pub fn github_base(remote: &str) -> Option<String> {
    let u = remote.trim().trim_end_matches('/');
    let rest = if let Some(r) = u.strip_prefix("git@") {
        r.replacen(':', "/", 1)
    } else {
        let r = ["https://", "http://", "ssh://", "git://", "git+ssh://"].iter().find_map(|p| u.strip_prefix(p))?;
        // No credentials in what's shown or opened.
        let r = r.split_once('@').filter(|(user, _)| !user.contains('/')).map_or(r, |x| x.1);
        r.to_string()
    };
    let (host, path) = rest.split_once('/')?;
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    if host != "github.com" && host != "www.github.com" {
        return None;
    }
    let path = path.trim_end_matches(".git");
    let mut parts = path.split('/').filter(|s| !s.is_empty());
    let (owner, repo) = (parts.next()?, parts.next()?);
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (parts.next().is_none() && ok(owner) && ok(repo)).then(|| format!("https://github.com/{owner}/{repo}"))
}

// ------------------------------------------------------------------ the cache

enum Entry {
    Pending,
    Commit(Commit),
    Miss(Instant),
}

fn cache() -> &'static Mutex<HashMap<(PathBuf, String), Entry>> {
    static C: OnceLock<Mutex<HashMap<(PathBuf, String), Entry>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// The commits among `tokens` that are known in `dir` now. Tokens not looked up yet are looked
/// up on a thread, which calls `done` when it has an answer (the next call then has it).
pub fn known(dir: &Path, tokens: &[String], done: impl Fn() + Send + 'static) -> HashMap<String, Commit> {
    let mut out = HashMap::new();
    if tokens.is_empty() {
        return out;
    }
    let mut ask = vec![];
    {
        let mut c = cache().lock().unwrap();
        for t in tokens {
            let key = (dir.to_path_buf(), t.clone());
            match c.get(&key) {
                Some(Entry::Commit(commit)) => {
                    out.insert(t.clone(), commit.clone());
                }
                Some(Entry::Pending) => {}
                Some(Entry::Miss(at)) if at.elapsed() < FORGET_MISS => {}
                _ => {
                    c.insert(key, Entry::Pending);
                    ask.push(t.clone());
                }
            }
        }
    }
    if !ask.is_empty() {
        let dir = dir.to_path_buf();
        std::thread::spawn(move || {
            let found = if dir.is_dir() { resolve(&dir, &ask) } else { HashMap::new() };
            let mut c = cache().lock().unwrap();
            for t in ask {
                let e = match found.get(&t) {
                    Some(commit) => Entry::Commit(commit.clone()),
                    None => Entry::Miss(Instant::now()),
                };
                c.insert((dir.clone(), t), e);
            }
            drop(c);
            if !found.is_empty() {
                done();
            }
        });
    }
    out
}

/// The commits a reply names, as far as they're known (see `known`).
pub fn of_text(dir: Option<&Path>, md: &str, done: impl Fn() + Send + 'static) -> Arc<HashMap<String, Commit>> {
    match dir {
        Some(d) => {
            let c = candidates(md);
            if c.is_empty() {
                return Default::default();
            }
            Arc::new(known(d, &c, done))
        }
        None => Default::default(),
    }
}

// ------------------------------------------------------------------ desktop markdown

/// The pill's text: the git-commit glyph and the short id, between no-break spaces (inline code
/// trims plain spaces), so it never wraps and has room inside its chip.
pub fn pill_text(c: &Commit) -> String {
    format!("\u{a0}{}\u{a0}{}\u{a0}", crate::icons::GIT_COMMIT, short7(c))
}

pub fn short7(c: &Commit) -> &str {
    let n = c.short.len().max(7).min(c.sha.len());
    &c.sha[..n]
}

/// The reply with each known commit as a link the viewer hands back (`SCHEME`), its text in code
/// style (mono); `paint_pills` turns that into the chip.
pub fn pills_md<'a>(md: &'a str, commits: &HashMap<String, Commit>) -> std::borrow::Cow<'a, str> {
    if commits.is_empty() {
        return md.into();
    }
    let mut out = String::with_capacity(md.len() + 64);
    let mut at = 0;
    for s in sites(md) {
        let Some(c) = commits.get(&s.token) else { continue };
        if s.range.start < at {
            continue;
        }
        out.push_str(&md[at..s.range.start]);
        out.push_str(&format!("[`{}`]({SCHEME}{})", pill_text(c), c.sha));
        at = s.range.end;
    }
    out.push_str(&md[at..]);
    out.into()
}

// ------------------------------------------------------------------ phone block model

/// Splits the spans of the phone's block model so each known commit is a span of its own with
/// `commit` set (its text stays the token, so an older app shows what it showed before).
pub fn mark(blocks: &mut [crate::api::Block], commits: &HashMap<String, Commit>) {
    use crate::api::Block;
    if commits.is_empty() {
        return;
    }
    for b in blocks {
        match b {
            Block::Heading { spans, .. } | Block::Paragraph { spans } => *spans = split(std::mem::take(spans), commits),
            Block::List { items, .. } => items.iter_mut().for_each(|i| mark(i, commits)),
            Block::Quote { blocks } => mark(blocks, commits),
            Block::Table { rows } => rows.iter_mut().flatten().for_each(|cell| *cell = split(std::mem::take(cell), commits)),
            Block::Code { .. } | Block::Rule => {}
        }
    }
}

fn split(spans: Vec<crate::api::Span>, commits: &HashMap<String, Commit>) -> Vec<crate::api::Span> {
    let mut out = vec![];
    for s in spans {
        if s.link.is_some() || s.commit.is_some() {
            out.push(s);
            continue;
        }
        if s.code {
            match commits.get(s.text.trim()) {
                Some(c) => out.push(crate::api::Span { commit: Some(c.sha.clone()), ..s }),
                None => out.push(s),
            }
            continue;
        }
        let mut at = 0;
        for r in tokens(&s.text) {
            let Some(c) = commits.get(&s.text[r.clone()]) else { continue };
            if r.start > at {
                out.push(crate::api::Span { text: s.text[at..r.start].to_string(), ..s.clone() });
            }
            out.push(crate::api::Span { text: s.text[r.clone()].to_string(), commit: Some(c.sha.clone()), ..s.clone() });
            at = r.end;
        }
        if at == 0 {
            out.push(s);
        } else if at < s.text.len() {
            out.push(crate::api::Span { text: s.text[at..].to_string(), ..s });
        }
    }
    out
}

/// The `commits` map of an item on the wire: full sha → what its pill shows.
pub fn wire(commits: &HashMap<String, Commit>) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    for c in commits.values() {
        m.insert(c.sha.clone(), c.json());
    }
    serde_json::Value::Object(m)
}

// ------------------------------------------------------------------ desktop

use crate::app::App;
use crate::prdetail::Line;
use eframe::egui;

type Shared<T> = Arc<Mutex<Option<T>>>;

/// The open commit card (a dialog).
pub struct Card {
    pub sha: String,
    dir: Option<PathBuf>,
    detail: Shared<Result<Detail, String>>,
    diff: Option<Shared<Result<Vec<Line>, String>>>,
    copied: Option<Instant>,
}

impl Card {
    pub fn showing_diff(&self) -> bool {
        self.diff.is_some()
    }
}

fn later<T: Send + 'static>(ctx: &egui::Context, f: impl FnOnce() -> T + Send + 'static) -> Shared<T> {
    let slot: Shared<T> = Default::default();
    let (s, ctx) = (slot.clone(), ctx.clone());
    std::thread::spawn(move || {
        let v = f();
        *s.lock().unwrap() = Some(v);
        ctx.request_repaint();
    });
    slot
}

/// Draws the pills `pills_md` left in the markdown viewer's output (shapes painted since
/// `from` on this layer): the code-styled link becomes a rounded chip with the git-commit glyph
/// and the short id, the subject on hover. The link itself (and its click) stays.
pub fn paint_pills(ui: &egui::Ui, from: usize, commits: &HashMap<String, Commit>, t: &crate::theme::Tokens) {
    use egui::epaint::{Shape, TextShape, text::LayoutJob, text::TextFormat};
    if commits.is_empty() {
        return;
    }
    let layer = ui.layer_id();
    let glyph = crate::icons::GIT_COMMIT;
    let found: Vec<(usize, TextShape, egui::Rect)> = ui.ctx().graphics(|g| {
        g.get(layer)
            .map(|l| {
                l.all_entries()
                    .enumerate()
                    .skip(from)
                    .filter_map(|(i, cs)| match &cs.shape {
                        Shape::Text(ts) if ts.galley.rows.len() == 1 && ts.galley.job.text.contains(glyph) => Some((i, ts.clone(), cs.clip_rect)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    });
    for (i, ts, clip) in found {
        let text = ts.galley.job.text.clone();
        let Some(c) = commits.values().find(|c| text.contains(short7(c))) else { continue };
        // In a wrapped paragraph the galley starts at the row's start: only the glyphs count.
        let r = ts.galley.rows[0].rect_without_leading_space().translate(ts.pos.to_vec2());
        let rect = egui::Rect::from_min_max(egui::pos2(r.left(), r.top() + 0.5), egui::pos2(r.right(), r.bottom() - 0.5));
        let resp = ui.interact(rect.intersect(clip), ui.scope_id().with(("commit-pill", i)), egui::Sense::hover());
        let hovered = resp.hovered();
        let font = ts.galley.job.sections.first().map(|s| s.format.font_id.clone()).unwrap_or_else(|| egui::FontId::monospace(13.0));
        let mut job = LayoutJob::default();
        let fmt = |color| TextFormat { font_id: font.clone(), color, ..Default::default() };
        job.append("\u{a0}", 0.0, fmt(t.subtle()));
        job.append(glyph, 0.0, fmt(if hovered { t.fg() } else { t.subtle() }));
        job.append(&format!("\u{a0}{}\u{a0}", short7(c)), 0.0, fmt(t.fg()));
        let galley = ui.ctx().fonts_mut(|f| f.layout_job(job));
        let fill = if hovered { t.gray(200) } else { t.gray(100) };
        let chip = egui::epaint::RectShape::new(rect, egui::CornerRadius::same(crate::theme::RADIUS_MD), fill, egui::Stroke::new(1.0, t.border()), egui::StrokeKind::Inside);
        let shape = Shape::Vec(vec![Shape::Rect(chip), Shape::Text(TextShape::new(r.min, galley, t.fg()))]);
        ui.ctx().graphics_mut(|g| g.entry(layer).set(egui::layers::ShapeIdx(i), clip, shape));
        let when = crate::app::ago(c.at);
        use crate::widgets::Tip as _;
        resp.tip(format!("{}\n{} · {} · {when}", c.subject, short7(c), c.author));
    }
}

impl App {
    /// GET /v1/chats/{id}/commit/{sha}[?diff=1]: a pill's card, from git on a thread. True when
    /// the call was this one (answered now or by the thread).
    pub fn commit_api(&self, call: &crate::api::Call) -> bool {
        use crate::api::{err, ok};
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        let ("GET", ["v1", "chats", c, "commit", sha]) = (call.method.as_str(), p.as_slice()) else { return false };
        let Some(chat) = self.ref_id(c).filter(|c| self.chat(*c).is_some()) else {
            let _ = call.reply.send(err(404, "no such chat"));
            return true;
        };
        let Some(dir) = self.commit_dir(chat) else {
            let _ = call.reply.send(err(404, "this chat has no project on this PC"));
            return true;
        };
        let (sha, with_diff, tx) = (sha.to_string(), call.query.iter().any(|(k, v)| k == "diff" && v == "1"), call.reply.clone());
        std::thread::spawn(move || {
            let r = match detail(&dir, &sha) {
                Ok(d) => {
                    let mut v = d.json();
                    if with_diff {
                        let lines = diff(&dir, &d.commit.sha).map(|t| crate::ghapi::diff_json(&t)).unwrap_or_else(|_| serde_json::json!({ "lines": [] }));
                        v["lines"] = lines["lines"].clone();
                        v["clipped"] = lines["clipped"].clone();
                    }
                    ok(v)
                }
                Err(e) => err(404, e),
            };
            let _ = tx.send(r);
        });
        true
    }

    /// A pill was clicked: its card.
    pub fn open_commit(&mut self, chat: i64, sha: &str, ctx: &egui::Context) {
        let dir = self.commit_dir(chat);
        let (d, s) = (dir.clone(), sha.to_string());
        let detail = later(ctx, move || match d {
            Some(d) => crate::commits::detail(&d, &s),
            None => Err("This chat's project isn't on this PC.".into()),
        });
        self.dialog = Some(crate::app::Dialog::Commit(Box::new(Card { sha: sha.to_string(), dir, detail, diff: None, copied: None })));
    }

    pub fn commit_dialog(&mut self, ui: &mut egui::Ui, card: &mut Card, close: &mut bool) {
        use crate::icons as ic;
        use crate::theme;
        use crate::widgets::{self as w, Tip as _};
        use egui::{Align, Layout, RichText, ScrollArea};
        let t = self.theme.t;
        let detail = card.detail.lock().unwrap().clone();
        let d = match detail {
            None => {
                ui.horizontal(|ui| {
                    w::busy(ui);
                    w::subtle(ui, "Loading the commit…", "label-14");
                });
                return;
            }
            Some(Err(e)) => {
                w::text(ui, "Commit", "heading-20");
                ui.add_space(8.0);
                ui.label(RichText::new(format!("{}  {e}", short_of(&card.sha))).text_style(theme::ts("label-13-mono")).color(t.subtle()));
                return;
            }
            Some(Ok(d)) => d,
        };
        let c = &d.commit;
        ui.add(egui::Label::new(RichText::new(&c.subject).text_style(theme::ts("heading-20")).color(t.fg())).wrap());
        ui.add_space(6.0);
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            ui.label(RichText::new(format!("{}  {}", ic::GIT_COMMIT, short7(c))).text_style(theme::ts("label-13-mono")).color(t.fg())).tip(c.sha.clone());
            let who = if d.email.is_empty() { c.author.clone() } else { format!("{} <{}>", c.author, d.email) };
            ui.label(RichText::new(format!("·  {}  ·  {}", c.author, crate::app::ago(c.at))).text_style(theme::ts("label-13")).color(t.subtle())).tip(who);
        });
        if !d.body.is_empty() {
            ui.add_space(12.0);
            ScrollArea::vertical().id_salt("commit-body").max_height(160.0).auto_shrink([false, true]).show(ui, |ui| {
                ui.add(egui::Label::new(RichText::new(&d.body).text_style(theme::ts("copy-14")).color(t.fg())).wrap());
            });
        }
        // Changed files with their counts.
        ui.add_space(14.0);
        let (adds, dels) = d.files.iter().fold((0, 0), |(a, z), f| (a + f.adds.unwrap_or(0), z + f.dels.unwrap_or(0)));
        let n = d.files.len() + d.more_files;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            w::text(ui, &format!("{n} file{} changed", if n == 1 { "" } else { "s" }), "label-13");
            ui.label(RichText::new(format!("+{adds}")).text_style(theme::ts("label-13-mono")).color(t.green(900)));
            ui.label(RichText::new(format!("−{dels}")).text_style(theme::ts("label-13-mono")).color(t.red(900)));
        });
        ui.add_space(6.0);
        if card.diff.is_none() && !d.files.is_empty() {
            w::well(ui).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ScrollArea::vertical().id_salt("commit-files").max_height(180.0).auto_shrink([false, true]).show(ui, |ui| {
                    for f in &d.files {
                        ui.horizontal(|ui| {
                            let counts = match (f.adds, f.dels) {
                                (Some(a), Some(z)) => format!("+{a} −{z}"),
                                _ => "binary".into(),
                            };
                            let mono = egui::FontId::monospace(12.0);
                            let cw = ui.painter().layout_no_wrap(counts.clone(), mono.clone(), t.subtle()).size().x + 8.0;
                            let g = w::truncated(ui, &f.path, mono.clone(), t.fg(), (ui.available_width() - cw).max(40.0));
                            ui.label(g).tip(f.path.clone());
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.spacing_mut().item_spacing.x = 4.0;
                                if let (Some(a), Some(z)) = (f.adds, f.dels) {
                                    ui.label(RichText::new(format!("−{z}")).font(mono.clone()).color(t.red(900)));
                                    ui.label(RichText::new(format!("+{a}")).font(mono.clone()).color(t.green(900)));
                                } else {
                                    ui.label(RichText::new("binary").font(mono.clone()).color(t.subtle()));
                                }
                            });
                        });
                    }
                    if d.more_files > 0 {
                        w::subtle(ui, &format!("and {} more", d.more_files), "label-12");
                    }
                });
            });
        }
        if let Some(diff) = &card.diff {
            let got = diff.lock().unwrap().clone();
            match got {
                None => {
                    ui.horizontal(|ui| {
                        w::busy(ui);
                        w::subtle(ui, "Loading the diff…", "label-14");
                    });
                }
                Some(Err(e)) => {
                    ui.label(RichText::new(e).text_style(theme::ts("label-13-mono")).color(t.red(900)));
                }
                Some(Ok(lines)) => {
                    egui::Frame::new().stroke(egui::Stroke::new(1.0, t.border())).corner_radius(egui::CornerRadius::same(theme::RADIUS_MD)).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        crate::prdetail::diff_rows(ui, &t, egui::Id::NULL.with(("commit-diff", &card.sha)), &lines, true);
                    });
                }
            }
        }
        ui.add_space(16.0);
        let copied = card.copied.is_some_and(|at| at.elapsed() < Duration::from_millis(1500));
        if copied {
            ui.ctx().request_repaint_after(Duration::from_millis(300));
        }
        ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
            if let Some(url) = &d.url {
                if w::btn(&format!("{}  Open on GitHub", ic::EXTERNAL)).primary().show(ui).tip(url.clone()).clicked() {
                    crate::git::open_url(url);
                    *close = true;
                }
            }
            let label = if copied { format!("{}  Copied", ic::CHECK) } else { format!("{}  Copy SHA", ic::COPY) };
            if w::btn(&label).outline().show(ui).tip(c.sha.clone()).clicked() {
                ui.ctx().copy_text(c.sha.clone());
                card.copied = Some(Instant::now());
            }
            let showing = card.diff.is_some();
            if w::btn(if showing { "Hide diff" } else { "Show diff" }).outline().show(ui).clicked() {
                card.diff = if showing {
                    None
                } else {
                    let (dir, sha) = (card.dir.clone(), c.sha.clone());
                    Some(later(ui.ctx(), move || match dir {
                        Some(dir) => diff(&dir, &sha).map(|t| crate::prdetail::parse_diff(&t)),
                        None => Err("This chat's project isn't on this PC.".into()),
                    }))
                };
            }
        });
    }
}

fn short_of(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<&str> {
        tokens(s).into_iter().map(|r| &s[r]).collect()
    }

    #[test]
    fn hashes_are_found_and_lookalikes_are_not() {
        assert_eq!(toks("Pushed 7dfbd05 and 35cbb88."), ["7dfbd05", "35cbb88"]);
        assert_eq!(toks("full: 35cbb88a1f2e3d4c5b6a79880716253443526170, done"), ["35cbb88a1f2e3d4c5b6a79880716253443526170"]);
        assert_eq!(toks("(ac358de)"), ["ac358de"]);
        // Too short, too long (a sha256), no digit, no letter, uppercase.
        assert!(toks("abc12f 1234567 deadbeefcafe ABCDEF1").is_empty());
        assert!(toks(&"a1".repeat(32)).is_empty());
        // A colour, a UUID, a path, a URL, 0x…, a fingerprint, an e-mail, a file name, key=value.
        for s in ["#a1b2c3d4", "550e8400-e29b-41d4-a716-446655440000", "/tmp/a1b2c3d4/x", "https://x.dev/c/a1b2c3d4", "0xa1b2c3d4", "SHA256:ab12cd34ef56", "ab:cd:ef:12:34:56:78", "a1b2c3d4@host", "a1b2c3d4.png", "id=a1b2c3d4", "port a1b2c3d:80"] {
            assert!(toks(s).is_empty(), "{s}");
        }
        // Words around it are fine, glued ones aren't.
        assert!(toks("x7dfbd05 7dfbd05y 7dfbd05_").is_empty());
    }

    #[test]
    fn markdown_sites_skip_code_blocks_and_links() {
        let md = "Fixed in 7dfbd05 and `35cbb88`.\n\n```\ngit show ac358de\n```\n\n    1ab0034 indented\n\n[see a8f7125](https://x.dev) and `git show ce77938`\n\n- item **b4b7522**\n";
        let s = sites(md);
        let got: Vec<(&str, bool)> = s.iter().map(|s| (s.token.as_str(), s.code)).collect();
        assert_eq!(got, [("7dfbd05", false), ("35cbb88", true), ("b4b7522", false)]);
        assert_eq!(&md[s[1].range.clone()], "`35cbb88`");
        assert!(sites("no hashes here").is_empty());
    }

    fn commit(sha: &str) -> Commit {
        Commit { sha: sha.into(), short: sha[..7].into(), subject: "Fix it".into(), author: "A".into(), at: 1 }
    }

    #[test]
    fn pills_replace_only_known_commits() {
        let full = "7dfbd05c2aa1b2c3d4e5f60718293a4b5c6d7e8f";
        let known: HashMap<String, Commit> = [("7dfbd05c2".to_string(), commit(full))].into();
        let md = "Shipped `7dfbd05c2`, not 35cbb88.";
        let out = pills_md(md, &known);
        assert_eq!(out, format!("Shipped [`{}`]({SCHEME}{full}), not 35cbb88.", pill_text(&known["7dfbd05c2"])));
        assert!(pill_text(&known["7dfbd05c2"]).contains("7dfbd05") && !pill_text(&known["7dfbd05c2"]).contains("7dfbd05c"));
        assert_eq!(pills_md(md, &HashMap::new()), md);
    }

    #[test]
    fn phone_spans_are_split_at_commits() {
        let full = "35cbb88a1f2e3d4c5b6a79880716253443526170";
        let known: HashMap<String, Commit> = [("35cbb88".to_string(), commit(full))].into();
        let mut b = crate::api::blocks("Released 35cbb88 today, see `35cbb88` and ```x```.\n\n```\n35cbb88\n```\n");
        mark(&mut b, &known);
        let v = serde_json::to_value(&b).unwrap();
        let spans = v[0]["spans"].as_array().unwrap();
        assert_eq!(spans[0]["text"], "Released ");
        assert_eq!((spans[1]["text"].as_str(), spans[1]["commit"].as_str()), (Some("35cbb88"), Some(full)));
        assert_eq!(spans[2]["text"], " today, see ");
        assert_eq!((spans[3]["code"].as_bool(), spans[3]["commit"].as_str()), (Some(true), Some(full)));
        assert!(spans[2].get("commit").is_none());
        // The code block is untouched.
        assert_eq!(v[1]["text"], "35cbb88");
        assert_eq!(wire(&known)[full]["short"], "35cbb88");
    }

    #[test]
    fn github_urls_from_remotes() {
        for u in [
            "git@github.com:o/r.git",
            "git@github.com:o/r",
            "ssh://git@github.com/o/r.git",
            "ssh://git@github.com:22/o/r",
            "https://github.com/o/r.git",
            "https://github.com/o/r/",
            "http://github.com/o/r",
            "https://user:ghp_secret@github.com/o/r.git",
            "git://github.com/o/r.git",
            "https://www.GitHub.com/o/r",
        ] {
            assert_eq!(github_base(u).as_deref(), Some("https://github.com/o/r"), "{u}");
        }
        for u in ["git@gitlab.com:o/r.git", "https://example.org/o/r", "/srv/git/r.git", "https://github.com/o", "https://github.com/o/r/tree/x", "file:///tmp/r"] {
            assert_eq!(github_base(u), None, "{u}");
        }
    }

    #[test]
    fn resolves_real_commits_only() {
        let dir = std::env::temp_dir().join(format!("harbor-commits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&dir).args(["-c", "user.name=T", "-c", "user.email=t@example.com"]).args(args).output().unwrap();
            assert!(out.status.success(), "{:?}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        g(&["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        g(&["add", "a.txt"]);
        g(&["commit", "-q", "-m", "Add a\n\nThe body."]);
        g(&["remote", "add", "origin", "git@github.com:o/r.git"]);
        let sha = g(&["rev-parse", "HEAD"]);
        let tree = g(&["rev-parse", "HEAD^{tree}"]);
        let short = sha[..9].to_string();
        let fake = "0123abc0123abc0".to_string();
        let found = resolve(&dir, &[short.clone(), fake.clone(), tree[..10].to_string()]);
        assert_eq!(found.len(), 1, "a tree or an unknown id isn't a commit");
        assert_eq!((found[&short].sha.as_str(), found[&short].subject.as_str(), found[&short].author.as_str()), (sha.as_str(), "Add a", "T"));
        let d = detail(&dir, &short).unwrap();
        assert_eq!(d.body, "The body.");
        assert_eq!(d.email, "t@example.com");
        assert_eq!(d.files, [FileStat { path: "a.txt".into(), adds: Some(2), dels: Some(0) }]);
        assert_eq!(d.url, Some(format!("https://github.com/o/r/commit/{sha}")));
        assert!(diff(&dir, &sha).unwrap().contains("+two"));
        assert!(detail(&dir, &fake).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
