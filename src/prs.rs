//! Pull requests page, after T3 Code's: every PR you wrote, were asked to
//! review, or that lives in one of your projects' GitHub repos, fetched with
//! the GitHub CLI and grouped (Authored / Review requested / Others). Search
//! (with `label:` and friends), sort and filters run on the fetched list.

use crate::app::{App, Bg, View};
use crate::chat::centered;
use crate::icons as ic;
use crate::providers;
use crate::theme::{self, RADIUS_MD};
use crate::widgets::{self as w, alpha};
use eframe::egui::{self, Align2, Color32, CornerRadius, CursorIcon, FontId, Frame, Id, Margin, Rect, ScrollArea, Sense, Stroke, StrokeKind, Ui, Vec2, pos2};
use std::collections::{HashMap, HashSet};

// ------------------------------------------------------------------ model

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Review {
    Approved,
    Changes,
    Required,
    None,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Checks {
    Passing,
    Failing,
    Pending,
    None,
}

#[derive(Clone, Debug)]
pub struct Pr {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// owner/name
    pub repo: String,
    pub state: PrState,
    pub draft: bool,
    pub adds: u64,
    pub dels: u64,
    pub created: i64,
    pub updated: i64,
    pub branch: String,
    pub review: Review,
    pub checks: Checks,
    pub conflicting: bool,
    pub author: String,
    pub avatar: String,
    pub labels: Vec<(String, [u8; 3])>,
    /// The viewer (or a team of theirs) was asked to review it.
    pub review_requested: bool,
}

impl Pr {
    fn size(&self) -> u64 {
        self.adds + self.dels
    }
}

#[derive(Clone, Default)]
pub struct Fetched {
    pub viewer: String,
    pub items: Vec<Pr>,
}

#[derive(Clone, Copy, PartialEq, Default)]
pub enum Sort {
    #[default]
    Ready,
    Blocked,
    Updated,
    Newest,
    Oldest,
    Largest,
    Smallest,
}

impl Sort {
    const ALL: [Sort; 7] = [Sort::Ready, Sort::Blocked, Sort::Updated, Sort::Newest, Sort::Oldest, Sort::Largest, Sort::Smallest];

    fn label(self) -> &'static str {
        match self {
            Sort::Ready => "Merge readiness",
            Sort::Blocked => "Blocked on me",
            Sort::Updated => "Recently updated",
            Sort::Newest => "Newest shown",
            Sort::Oldest => "Oldest shown",
            Sort::Largest => "Largest shown",
            Sort::Smallest => "Smallest shown",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Sort::Ready => ic::LIST_CHECKS,
            Sort::Blocked => ic::USER_LOCK,
            Sort::Updated => ic::CLOCK,
            Sort::Newest => ic::CALENDAR_DOWN,
            Sort::Oldest => ic::CALENDAR_UP,
            Sort::Largest => ic::MAXIMIZE,
            Sort::Smallest => ic::MINIMIZE,
        }
    }
}

/// The State filter; the only one GitHub applies (the others run here).
#[derive(Clone, Copy, PartialEq, Default, Debug)]
pub enum StateF {
    All,
    #[default]
    Open,
    Closed,
    Merged,
}

#[derive(Clone, Copy, PartialEq, Default)]
pub enum Involvement {
    #[default]
    All,
    Reviewing,
    Authored,
}

#[derive(Clone, Default)]
pub struct Filters {
    pub state: StateF,
    pub involvement: Involvement,
    pub author: Option<String>,
    /// Every label must be on the PR.
    pub labels: Vec<String>,
    /// Some(true): drafts only; Some(false): hide drafts.
    pub draft: Option<bool>,
    pub review: Option<Review>,
    pub checks: Option<Checks>,
    /// owner/name of the picked project's repo.
    pub project: Option<String>,
}

impl Filters {
    /// The count on the Filters button: everything not at its default.
    fn active(&self, project: bool) -> usize {
        [
            self.state != StateF::Open,
            self.involvement != Involvement::All,
            project,
            self.draft.is_some(),
            self.review.is_some(),
            self.checks.is_some(),
            self.author.is_some(),
        ]
        .iter()
        .filter(|b| **b)
        .count()
            + self.labels.len()
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Menu {
    Sort,
    Filters,
    Provider,
}

#[derive(Clone, Copy, PartialEq)]
enum Sub {
    State,
    Involvement,
    Author,
    Labels,
    Draft,
    Review,
    Checks,
    Project,
}

#[derive(Default)]
pub struct Prs {
    /// Where the close button goes.
    pub back: Option<View>,
    pub loading: bool,
    generation: u64,
    pub data: Option<Result<Fetched, String>>,
    fetched: Option<StateF>,
    pub search: String,
    pub sort: Sort,
    pub filters: Filters,
    /// Harbor project picked in the Project filter.
    pub project: Option<i64>,
    /// The source picker: false = All, true = GitHub (the only provider).
    github_only: bool,
    menu: Option<Menu>,
    menu_anchor: Option<Rect>,
    sub: Option<Sub>,
    sub_anchor: Option<Rect>,
    /// Keyboard highlight in the open menu and in its submenu.
    keys: crate::listdetail::MenuKeys,
    sub_keys: Option<crate::listdetail::MenuKeys>,
    /// The PRs open as tabs in the side panel (keyed by URL).
    pub split: crate::listdetail::Split,
    pub details: HashMap<String, crate::prdetail::Detail>,
    pub avatars: HashMap<String, Option<egui::TextureHandle>>,
    /// Lets fetch threads wake the UI.
    ctx: Option<egui::Context>,
}

// ------------------------------------------------------------------ fetching

const FIELDS: &str = "... on PullRequest { number title url state isDraft additions deletions createdAt updatedAt headRefName reviewDecision mergeable \
repository { nameWithOwner } author { login avatarUrl(size: 40) } labels(first: 10) { nodes { name color } } \
commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }";

fn state_qualifier(s: StateF) -> &'static str {
    match s {
        StateF::All => "",
        StateF::Open => " is:open",
        StateF::Closed => " is:closed is:unmerged",
        StateF::Merged => " is:merged",
    }
}

/// The GraphQL query: PRs you authored, PRs awaiting your review and PRs in
/// the given repos (chunked: search caps a query's length).
fn query(state: StateF, repos: &[String]) -> String {
    let st = state_qualifier(state);
    let mut q = String::from("query { viewer { login } ");
    let mut search = |alias: &str, s: &str, n: u32| {
        let s = s.replace('\\', "").replace('"', "");
        q.push_str(&format!("{alias}: search(query: \"{s}\", type: ISSUE, first: {n}) {{ nodes {{ {FIELDS} }} }} "));
    };
    search("authored", &format!("is:pr author:@me archived:false sort:updated-desc{st}"), 50);
    search("reviewing", &format!("is:pr review-requested:@me archived:false sort:updated-desc{st}"), 50);
    for (i, chunk) in repos.chunks(5).enumerate() {
        let rs: Vec<String> = chunk.iter().map(|r| format!("repo:{r}")).collect();
        search(&format!("p{i}"), &format!("is:pr sort:updated-desc{st} {}", rs.join(" ")), 100);
    }
    q.push('}');
    q
}

pub fn fetch(state: StateF, repos: &[String]) -> Result<Fetched, String> {
    let out = std::process::Command::new("gh")
        .args(["api", "graphql", "-f"])
        .arg(format!("query={}", query(state, repos)))
        .env("PATH", providers::child_path())
        .output();
    let out = match out {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("The GitHub CLI (gh) isn't installed. Install it and run `gh auth login` to see your pull requests.".into());
        }
        Err(e) => return Err(format!("gh: {e}")),
    };
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    if !out.status.success() && v["data"].is_null() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.contains("auth login") || err.contains("not logged") { "Not signed in to GitHub. Run `gh auth login`.".into() } else { err });
    }
    Ok(parse(&v))
}

fn parse(v: &serde_json::Value) -> Fetched {
    let d = &v["data"];
    let viewer = d["viewer"]["login"].as_str().unwrap_or("").to_string();
    let reviewing: HashSet<String> =
        d["reviewing"]["nodes"].as_array().into_iter().flatten().filter_map(|n| n["url"].as_str().map(String::from)).collect();
    let mut seen = HashSet::new();
    let mut items = vec![];
    let mut aliases: Vec<&String> = d.as_object().map(|o| o.keys().filter(|k| *k != "viewer").collect()).unwrap_or_default();
    aliases.sort();
    for a in aliases {
        for n in d[a]["nodes"].as_array().into_iter().flatten() {
            let Some(pr) = node(n) else { continue };
            if seen.insert(pr.url.clone()) {
                items.push(Pr { review_requested: reviewing.contains(&pr.url), ..pr });
            }
        }
    }
    items.sort_by(|a, b| b.updated.cmp(&a.updated));
    Fetched { viewer, items }
}

fn node(n: &serde_json::Value) -> Option<Pr> {
    let s = |k: &str| n[k].as_str().unwrap_or("").to_string();
    let url = n["url"].as_str()?.to_string();
    let color = |c: &str| {
        let h = |i: usize| c.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok()).unwrap_or(128);
        [h(0), h(2), h(4)]
    };
    Some(Pr {
        number: n["number"].as_u64()?,
        title: s("title"),
        url,
        repo: n["repository"]["nameWithOwner"].as_str().unwrap_or("").to_string(),
        state: match n["state"].as_str() {
            Some("MERGED") => PrState::Merged,
            Some("CLOSED") => PrState::Closed,
            _ => PrState::Open,
        },
        draft: n["isDraft"].as_bool().unwrap_or(false),
        adds: n["additions"].as_u64().unwrap_or(0),
        dels: n["deletions"].as_u64().unwrap_or(0),
        created: iso_secs(&s("createdAt")).unwrap_or(0),
        updated: iso_secs(&s("updatedAt")).unwrap_or(0),
        branch: s("headRefName"),
        review: match n["reviewDecision"].as_str() {
            Some("APPROVED") => Review::Approved,
            Some("CHANGES_REQUESTED") => Review::Changes,
            Some("REVIEW_REQUIRED") => Review::Required,
            _ => Review::None,
        },
        checks: match n["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str() {
            Some("SUCCESS") => Checks::Passing,
            Some("FAILURE" | "ERROR") => Checks::Failing,
            Some("PENDING" | "EXPECTED") => Checks::Pending,
            _ => Checks::None,
        },
        conflicting: n["mergeable"].as_str() == Some("CONFLICTING"),
        author: n["author"]["login"].as_str().unwrap_or("ghost").to_string(),
        avatar: n["author"]["avatarUrl"].as_str().unwrap_or("").to_string(),
        labels: n["labels"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| Some((l["name"].as_str()?.to_string(), color(l["color"].as_str().unwrap_or("")))))
            .collect(),
        review_requested: false,
    })
}

/// "2026-09-24T12:00:00Z" → unix seconds.
pub fn iso_secs(s: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<i64>().ok());
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13).unwrap_or(0), n(14..16).unwrap_or(0), n(17..19).unwrap_or(0));
    // days_from_civil (Howard Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400 + hh * 3600 + mm * 60 + ss)
}

pub fn ago(ts: i64) -> String {
    let d = (crate::store::now() - ts).max(0);
    match d {
        0..60 => "just now".into(),
        60..3600 => format!("{}m ago", d / 60),
        3600..86400 => format!("{}h ago", d / 3600),
        86400..31_536_000 => format!("{}d ago", d / 86400),
        _ => format!("{}y ago", d / 31_536_000),
    }
}

pub fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

// ------------------------------------------------------------------ search, filters, sort

/// Filters typed in the search box, as T3 Code reads them: `label:a,b` (any of
/// them), several `label:` (all of them), `-label:x`, `author:`, `draft:true`,
/// `review:approved`, `checks:passing` (or `status:`). Any other `key:value`
/// is a label of that name (`type:bug`). The rest is free text.
#[derive(Default, Debug, PartialEq)]
pub struct Query {
    pub text: String,
    pub labels: Vec<Vec<String>>,
    pub excluded: Vec<String>,
    pub author: Option<String>,
    pub draft: Option<bool>,
    pub review: Option<Review>,
    pub checks: Option<Checks>,
}

fn tokens(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                cur.push(c);
            }
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn values(v: &str) -> Vec<String> {
    let v = v.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') && !v[1..v.len() - 1].contains('"') {
        let x = v.replace('"', "").trim().to_string();
        return if x.is_empty() { vec![] } else { vec![x] };
    }
    v.split(',').map(|x| x.replace('"', "").trim().to_string()).filter(|x| !x.is_empty()).take(10).collect()
}

pub fn parse_query(s: &str) -> Query {
    let mut q = Query::default();
    let mut text = vec![];
    for tok in tokens(s) {
        let neg = tok.starts_with('-');
        let body = if neg { &tok[1..] } else { &tok[..] };
        let kv = body.split_once(':').filter(|(k, _)| {
            k.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        });
        let Some((key, raw)) = kv else {
            text.push(tok);
            continue;
        };
        let val = raw.replace('"', "").trim().to_string();
        if val.is_empty() {
            text.push(tok);
            continue;
        }
        let lower = val.to_lowercase();
        let handled = match key.to_lowercase().as_str() {
            "label" => {
                let v = values(raw);
                if v.is_empty() {
                    false
                } else {
                    if neg { q.excluded.extend(v) } else { q.labels.push(v) }
                    true
                }
            }
            "author" if !neg => {
                q.author = Some(val.clone());
                true
            }
            "draft" if !neg && (lower == "true" || lower == "false") => {
                q.draft = Some(lower == "true");
                true
            }
            "review" if !neg => match lower.as_str() {
                "approved" => Some(Review::Approved),
                "changes_requested" | "changes-requested" => Some(Review::Changes),
                "required" | "review-required" => Some(Review::Required),
                "none" => Some(Review::None),
                _ => None,
            }
            .map(|r| q.review = Some(r))
            .is_some(),
            "checks" | "status" if !neg => match lower.as_str() {
                "success" | "passing" => Some(Checks::Passing),
                "failure" | "failing" => Some(Checks::Failing),
                _ => None,
            }
            .map(|c| q.checks = Some(c))
            .is_some(),
            "author" | "draft" | "review" | "checks" | "status" => false,
            _ if !val.starts_with('/') => {
                let v: Vec<String> = values(raw).into_iter().map(|x| if x.contains(':') { x } else { format!("{key}:{x}") }).collect();
                if v.is_empty() {
                    false
                } else {
                    if neg { q.excluded.extend(v) } else { q.labels.push(v) }
                    true
                }
            }
            _ => false,
        };
        if !handled {
            text.push(tok);
        }
    }
    q.text = text.join(" ");
    q
}

pub struct Group {
    pub key: &'static str,
    pub label: &'static str,
    pub icon: &'static str,
    pub items: Vec<Pr>,
}

fn authored(p: &Pr, viewer: &str) -> bool {
    !viewer.is_empty() && p.author.eq_ignore_ascii_case(viewer)
}

fn passes(p: &Pr, f: &Filters, q: &Query) -> bool {
    let has = |l: &str| p.labels.iter().any(|(n, _)| n.trim().eq_ignore_ascii_case(l.trim()));
    let state = match f.state {
        StateF::All => true,
        StateF::Open => p.state == PrState::Open,
        StateF::Closed => p.state == PrState::Closed,
        StateF::Merged => p.state == PrState::Merged,
    };
    let draft = q.draft.or(f.draft);
    let review = q.review.or(f.review);
    let checks = q.checks.or(f.checks);
    let author = q.author.as_ref().or(f.author.as_ref());
    state
        && f.project.as_ref().is_none_or(|r| p.repo.eq_ignore_ascii_case(r))
        && draft.is_none_or(|d| p.draft == d)
        && review.is_none_or(|r| p.review == r)
        && checks.is_none_or(|c| p.checks == c)
        && author.is_none_or(|a| p.author.eq_ignore_ascii_case(a.trim_start_matches('@')))
        && f.labels.iter().all(|l| has(l))
        && q.labels.iter().all(|any| any.iter().any(|l| has(l)))
        && !q.excluded.iter().any(|l| has(l))
}

fn matches_text(p: &Pr, text: &str) -> bool {
    let n = text.trim().to_lowercase();
    n.is_empty() || format!("#{} {} {} {} {}", p.number, p.title, p.repo, p.branch, p.author).to_lowercase().contains(&n)
}

/// How well a PR matches the free text (T3 Code's ranking).
fn relevance(p: &Pr, text: &str) -> u32 {
    let n = text.trim().to_lowercase();
    if n.is_empty() {
        return 0;
    }
    let num = n.trim_start_matches('#');
    if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
        return if p.number.to_string() == num { 100 } else { 0 };
    }
    let title = p.title.to_lowercase();
    let words: Vec<&str> = n.split_whitespace().collect();
    if title == n {
        90
    } else if title.contains(&n) {
        80
    } else if words.len() > 1 && words.iter().all(|w| title.contains(w)) {
        70
    } else if p.branch.to_lowercase().contains(&n) {
        60
    } else if p.author.to_lowercase().contains(&n) {
        50
    } else if p.repo.to_lowercase().contains(&n) {
        40
    } else if words.iter().any(|w| title.contains(w)) {
        30
    } else {
        10
    }
}

fn sort_group(items: &mut [Pr], key: &str, sort: Sort, text: &str, involvement: Involvement) {
    let text = text.trim();
    if !text.is_empty() && matches!(sort, Sort::Ready | Sort::Blocked | Sort::Updated) {
        items.sort_by(|a, b| relevance(b, text).cmp(&relevance(a, text)).then(b.updated.cmp(&a.updated)));
        return;
    }
    let has_stats = |p: &Pr| p.size() > 0;
    match sort {
        Sort::Ready => {
            let rank = |p: &Pr| match p.state {
                _ if p.conflicting => 4,
                PrState::Open if p.draft => 2,
                PrState::Open if p.checks == Checks::Passing && p.review == Review::Approved => 0,
                PrState::Open if p.checks == Checks::Passing => 1,
                PrState::Open => 2,
                _ => 3,
            };
            items.sort_by(|a, b| {
                rank(a).cmp(&rank(b)).then(has_stats(b).cmp(&has_stats(a))).then(a.size().cmp(&b.size())).then(b.updated.cmp(&a.updated))
            });
        }
        Sort::Blocked => {
            let whose = match key {
                "authored" => Involvement::Authored,
                "reviewRequested" => Involvement::Reviewing,
                _ => involvement,
            };
            let rank: fn(&Pr) -> u8 = match whose {
                Involvement::All => return,
                // Your PRs: what you must fix first.
                Involvement::Authored => |p| match p.state {
                    PrState::Open if p.conflicting => 0,
                    PrState::Open if p.review == Review::Changes => 1,
                    PrState::Open if p.checks == Checks::Failing => 2,
                    PrState::Open if p.draft => 3,
                    PrState::Open if p.checks == Checks::Passing && p.review == Review::Approved => 5,
                    PrState::Open => 4,
                    _ => 6,
                },
                // Others' PRs waiting on you: open ones first.
                Involvement::Reviewing => |p| if p.state == PrState::Open { 0 } else { 1 },
            };
            items.sort_by(|a, b| rank(a).cmp(&rank(b)).then(b.updated.cmp(&a.updated)));
        }
        Sort::Updated => items.sort_by(|a, b| b.updated.cmp(&a.updated)),
        Sort::Newest => items.sort_by(|a, b| b.created.cmp(&a.created).then(b.updated.cmp(&a.updated))),
        Sort::Oldest => items.sort_by(|a, b| a.created.cmp(&b.created).then(b.updated.cmp(&a.updated))),
        Sort::Largest | Sort::Smallest => items.sort_by(|a, b| {
            let s = if sort == Sort::Largest { b.size().cmp(&a.size()) } else { a.size().cmp(&b.size()) };
            has_stats(b).cmp(&has_stats(a)).then(s).then(b.updated.cmp(&a.updated))
        }),
    }
}

/// The page's sections, filtered and sorted.
pub fn groups(data: &Fetched, f: &Filters, search: &str, sort: Sort) -> Vec<Group> {
    let q = parse_query(search);
    let viewer = data.viewer.as_str();
    let items = data.items.iter().filter(|p| match f.involvement {
        Involvement::All => true,
        Involvement::Reviewing => p.review_requested,
        Involvement::Authored => authored(p, viewer),
    });
    let items: Vec<Pr> = items.filter(|p| passes(p, f, &q) && matches_text(p, &q.text)).cloned().collect();
    let mut out = if f.involvement != Involvement::All {
        vec![Group { key: "others", label: "", icon: "", items }]
    } else {
        let (mut a, mut r, mut o) = (vec![], vec![], vec![]);
        for p in items {
            if authored(&p, viewer) {
                a.push(p)
            } else if p.review_requested {
                r.push(p)
            } else {
                o.push(p)
            }
        }
        vec![
            Group { key: "authored", label: "Authored", icon: ic::PEN_LINE, items: a },
            Group { key: "reviewRequested", label: "Review requested", icon: ic::EYE, items: r },
            Group { key: "others", label: "Others", icon: ic::USERS, items: o },
        ]
    };
    out.retain(|g| !g.items.is_empty());
    for g in &mut out {
        g.items.sort_by(|a, b| b.updated.cmp(&a.updated));
        sort_group(&mut g.items, g.key, sort, &q.text, f.involvement);
    }
    out
}

/// Authors in the list, most PRs first.
pub fn authors(data: &Fetched) -> Vec<(String, usize)> {
    let mut m: HashMap<String, usize> = HashMap::new();
    for p in &data.items {
        *m.entry(p.author.clone()).or_default() += 1;
    }
    let mut v: Vec<_> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    v
}

/// Labels in the list, most used first.
pub fn labels(data: &Fetched) -> Vec<(String, [u8; 3], usize)> {
    let mut m: HashMap<String, ([u8; 3], usize)> = HashMap::new();
    for p in &data.items {
        for (n, c) in &p.labels {
            m.entry(n.clone()).or_insert((*c, 0)).1 += 1;
        }
    }
    let mut v: Vec<_> = m.into_iter().map(|(n, (c, k))| (n, c, k)).collect();
    v.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    v
}

/// owner/name of a GitHub remote URL.
pub fn github_repo(remote: &str) -> Option<String> {
    let rest = remote.strip_prefix("https://github.com/").or_else(|| remote.strip_prefix("http://github.com/"))?;
    let mut it = rest.trim_end_matches('/').split('/');
    let (o, n) = (it.next()?, it.next()?);
    (!o.is_empty() && !n.is_empty()).then(|| format!("{o}/{n}"))
}

// ------------------------------------------------------------------ app glue

impl App {
    /// Harbor projects with a GitHub remote: (id, name, owner/name).
    pub fn pr_projects(&self) -> Vec<(i64, String, String)> {
        self.repos
            .iter()
            .filter_map(|r| {
                let remote = self.git.get(&r.id)?.as_ref()?.remote.clone()?;
                Some((r.id, r.name.clone(), github_repo(&remote)?))
            })
            .collect()
    }

    pub fn open_prs(&mut self, project: Option<i64>) {
        if self.view != View::Prs {
            self.prs.back = Some(self.view);
        }
        if project.is_some() {
            self.prs.project = project;
        }
        self.open(View::Prs);
    }

    pub fn close_prs(&mut self) {
        let v = match self.prs.back.take() {
            Some(View::Chat(id)) if self.chat(id).is_none() => View::Draft,
            Some(View::Prs) | None => View::Draft,
            Some(v) => v,
        };
        self.open(v);
    }

    pub fn load_prs(&mut self) {
        let mut repos: Vec<String> = self.pr_projects().into_iter().map(|p| p.2).collect();
        repos.sort();
        repos.dedup();
        self.prs.generation += 1;
        self.prs.loading = true;
        let (generation, state) = (self.prs.generation, self.prs.filters.state);
        let tx = self.bg_tx.clone();
        let ctx = self.prs.ctx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Bg::Prs(generation, state, fetch(state, &repos)));
            if let Some(c) = ctx {
                c.request_repaint();
            }
        });
    }

    pub fn prs_loaded(&mut self, generation: u64, state: StateF, r: Result<Fetched, String>) {
        if generation != self.prs.generation {
            return;
        }
        self.prs.loading = false;
        let same = self.prs.fetched == Some(state);
        self.prs.fetched = Some(state);
        // A failed refresh keeps the list it had.
        if r.is_err() && same && matches!(self.prs.data, Some(Ok(_))) {
            return;
        }
        if let Ok(f) = &r {
            let want: Vec<(String, String)> = f
                .items
                .iter()
                .filter(|p| !p.avatar.is_empty() && !self.prs.avatars.contains_key(&p.author))
                .map(|p| (p.author.clone(), p.avatar.clone()))
                .collect::<HashMap<_, _>>()
                .into_iter()
                .take(40)
                .collect();
            for (login, _) in &want {
                self.prs.avatars.insert(login.clone(), None);
            }
            if !want.is_empty() {
                let tx = self.bg_tx.clone();
                let ctx = self.prs.ctx.clone();
                std::thread::spawn(move || {
                    for (login, url) in want {
                        let _ = tx.send(Bg::PrAvatar(login, avatar(&url)));
                        if let Some(c) = &ctx {
                            c.request_repaint();
                        }
                    }
                });
            }
        }
        self.prs.data = Some(r);
    }

    pub fn pr_avatar(&mut self, ctx: &egui::Context, login: String, img: Option<egui::ColorImage>) {
        let tex = img.map(|i| ctx.load_texture(format!("gh-avatar-{login}"), i, egui::TextureOptions::LINEAR));
        self.prs.avatars.insert(login, tex);
    }
}

fn avatar(url: &str) -> Option<egui::ColorImage> {
    let out = std::process::Command::new("curl").args(["-sfL", "--max-time", "10", url]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let img = image::load_from_memory(&out.stdout).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    Some(egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], img.as_raw()))
}

// ------------------------------------------------------------------ ui

fn merged_color(t: &theme::Tokens) -> Color32 {
    if t.dark { Color32::from_rgb(196, 181, 253) } else { Color32::from_rgb(124, 58, 237) }
}

fn state_icon(p: &Pr, t: &theme::Tokens) -> (&'static str, Color32, &'static str) {
    match p.state {
        PrState::Merged => (ic::GIT_MERGE, merged_color(t), "Merged"),
        PrState::Closed => (ic::PR_CLOSED, t.red(900), "Closed"),
        PrState::Open if p.conflicting => (ic::ALERT, t.amber(900), "Has conflicts"),
        PrState::Open if p.draft => (ic::PR_DRAFT, t.gray(800), "Draft"),
        PrState::Open => (ic::PR_OPEN, t.subtle(), "Open"),
    }
}

/// Outline toolbar button: icon, optional label, optional count badge.
pub fn tool_btn(ui: &mut Ui, icon: &str, label: &str, badge: Option<usize>, open: bool) -> egui::Response {
    let t = w::tokens(ui);
    let font = FontId::new(14.0, theme::medium());
    let g = (!label.is_empty()).then(|| ui.painter().layout_no_wrap(label.into(), font, t.fg()));
    let bg = badge.filter(|n| *n > 0).map(|n| ui.painter().layout_no_wrap(n.to_string(), FontId::new(12.0, egui::FontFamily::Monospace), t.subtle()));
    let wdt = match &g {
        None => 36.0,
        Some(g) => 12.0 + 16.0 + 8.0 + g.size().x + bg.as_ref().map_or(0.0, |b| b.size().x + 18.0) + 14.0,
    };
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(wdt, 36.0), Sense::click());
    let p = ui.painter();
    let fill = if resp.hovered() || open { t.accent() } else { t.bg100 };
    p.rect(rect, CornerRadius::same(RADIUS_MD), fill, Stroke::new(1.0, t.border()), StrokeKind::Inside);
    match g {
        None => {
            if icon == "github" {
                let r = Rect::from_center_size(rect.center(), Vec2::splat(17.0));
                if !crate::logos::paint(ui, p, r, "github", &t) {
                    ic::glyph(p, rect.center(), ic::GLOBE, 16.0, t.fg());
                }
            } else {
                ic::glyph(p, rect.center(), icon, 16.0, t.fg());
            }
        }
        Some(g) => {
            ic::glyph(p, pos2(rect.left() + 12.0 + 8.0, rect.center().y), icon, 16.0, t.fg());
            let x = rect.left() + 12.0 + 16.0 + 8.0;
            let gw = g.size().x;
            p.galley(pos2(x, rect.center().y - g.size().y / 2.0), g, t.fg());
            if let Some(b) = bg {
                let r = Rect::from_min_size(pos2(x + gw + 8.0, rect.center().y - 9.0), Vec2::new(b.size().x + 12.0, 18.0));
                p.rect_filled(r, CornerRadius::same(9), t.gray(200));
                p.galley(r.center() - b.size() / 2.0, b, t.subtle());
            }
        }
    }
    resp.on_hover_cursor(CursorIcon::PointingHand)
}

/// A floating menu surface at `pos` (top-left); returns its rect.
pub fn float<R>(ctx: &egui::Context, id: &str, pos: egui::Pos2, width: f32, t: &theme::Tokens, add: impl FnOnce(&mut Ui) -> R) -> (R, Rect) {
    let area = egui::Area::new(Id::NULL.with(id)).order(egui::Order::Foreground).fixed_pos(pos).constrain(true).show(ctx, |ui| {
        w::popover_frame(t)
            .show(ui, |ui| {
                ui.set_width(width);
                ui.spacing_mut().item_spacing.y = 0.0;
                add(ui)
            })
            .inner
    });
    (area.inner, area.response.rect)
}

/// Where a submenu of the row `a` opens: to its right, or to its left when the
/// window has no room there.
fn sub_pos(ctx: &egui::Context, a: Rect, width: f32) -> egui::Pos2 {
    let outer = width + 14.0;
    let x = if a.right() + 10.0 + outer > ctx.content_rect().right() { a.left() - 10.0 - outer } else { a.right() + 10.0 };
    pos2(x, a.top() - 6.0)
}

/// A menu row: icon, label, then a muted value and a chevron (submenus) or a check.
pub fn menu_row(ui: &mut Ui, icon: &str, label: &str, value: Option<&str>, chevron: bool, checked: bool, active: bool) -> egui::Response {
    let t = w::tokens(ui);
    let (rect, mut resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 32.0), Sense::click());
    let kb = crate::listdetail::row_key(ui, &mut resp);
    let p = ui.painter();
    if resp.hovered() || active || kb {
        p.rect_filled(rect, CornerRadius::same(RADIUS_MD), t.accent());
    }
    let mut x = rect.left() + 8.0;
    if !icon.is_empty() {
        ic::glyph(p, pos2(x + 8.0, rect.center().y), icon, 15.0, t.subtle());
        x += 26.0;
    }
    let mut right = rect.right() - 8.0;
    if chevron {
        ic::glyph(p, pos2(right - 6.0, rect.center().y), ic::RIGHT, 14.0, t.subtle());
        right -= 18.0;
    } else if checked {
        ic::glyph(p, pos2(right - 7.0, rect.center().y), ic::CHECK, 14.0, t.fg());
        right -= 20.0;
    }
    if let Some(v) = value {
        let g = w::truncated(ui, v, FontId::proportional(13.0), t.subtle(), 110.0);
        right -= g.size().x;
        p.galley(pos2(right, rect.center().y - g.size().y / 2.0), g, t.subtle());
        right -= 8.0;
    }
    let g = w::truncated(ui, label, FontId::proportional(14.0), t.fg(), (right - x).max(10.0));
    p.galley(pos2(x, rect.center().y - g.size().y / 2.0), g, t.fg());
    resp.on_hover_cursor(CursorIcon::PointingHand)
}

pub fn menu_sep(ui: &mut Ui) {
    let t = w::tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 9.0), Sense::hover());
    ui.painter().hline(rect.x_range().shrink(4.0), rect.center().y, Stroke::new(1.0, t.border()));
}

pub fn label_dot(p: &egui::Painter, c: egui::Pos2, rgb: [u8; 3]) {
    p.circle_filled(c, 4.0, Color32::from_rgb(rgb[0], rgb[1], rgb[2]));
}

const STATES: [(StateF, &str, &str); 4] =
    [(StateF::All, "All", ic::LAYERS), (StateF::Open, "Open", ic::PR_OPEN), (StateF::Closed, "Closed", ic::PR_CLOSED), (StateF::Merged, "Merged", ic::GIT_MERGE)];
const INVOLVEMENTS: [(Involvement, &str, &str); 3] =
    [(Involvement::All, "All", ic::LAYERS), (Involvement::Reviewing, "Reviewing", ic::EYE), (Involvement::Authored, "Authored", ic::PEN_LINE)];
const DRAFTS: [(Option<bool>, &str, &str); 3] = [(None, "All", ic::LAYERS), (Some(true), "Drafts only", ic::PR_DRAFT), (Some(false), "Hide drafts", ic::EYE_OFF)];
const REVIEWS: [(Option<Review>, &str, &str); 5] = [
    (None, "All", ic::LAYERS),
    (Some(Review::Approved), "Approved", ic::CIRCLE_CHECK),
    (Some(Review::Changes), "Changes requested", ic::CIRCLE_X),
    (Some(Review::Required), "Review required", ic::CIRCLE_DASHED),
    (Some(Review::None), "No reviews", ic::CIRCLE_SLASH),
];
const CHECKS: [(Option<Checks>, &str, &str); 3] =
    [(None, "All", ic::LAYERS), (Some(Checks::Passing), "Passing", ic::CIRCLE_CHECK), (Some(Checks::Failing), "Failing", ic::CIRCLE_X)];

fn name_of<T: PartialEq + Copy>(opts: &[(T, &'static str, &'static str)], v: T) -> &'static str {
    opts.iter().find(|o| o.0 == v).map_or("All", |o| o.1)
}

impl App {
    /// The page: the list, and beside it the side panel with the PRs opened as
    /// tabs (see listdetail.rs). Esc leaves the page.
    pub fn prs_view(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        let typing = ctx.text_edit_focused();
        let had_menu = self.prs.menu.is_some();
        if let Some(crate::listdetail::Shortcut::Tab(a)) = crate::listdetail::shortcuts(&ctx, &self.keys, &self.prs.split, Id::NULL.with("pr-search")) {
            self.prs.split.apply(a);
        }
        let rect = ui.available_rect_before_wrap();
        let (list, panel) = crate::listdetail::areas(ui, Id::NULL.with("pr-split"), &mut self.prs.split, rect);
        match list {
            Some(r) => crate::listdetail::region(ui, r, |ui| self.prs_list(ui, panel.is_some())),
            None => self.prs.menu = None,
        }
        if let Some(r) = panel {
            crate::listdetail::region(ui, r, |ui| self.pr_panel(ui));
        }
        ui.allocate_rect(rect, Sense::hover());
        let split = &self.prs.split;
        self.prs.details.retain(|k, _| split.tabs.contains(k));
        if !had_menu && self.prs.menu.is_none() && self.dialog.is_none() && self.popup.is_none() && crate::listdetail::esc_leaves(&ctx, typing) {
            self.close_prs();
        }
    }

    /// The side panel: a tab per opened PR, its controls, and the PR on show.
    fn pr_panel(&mut self, ui: &mut Ui) {
        ui.add_space(10.0);
        let (act, close) = crate::listdetail::header(ui, &self.prs.split, |url| (ic::PR_OPEN, format!("#{}", url.rsplit('/').next().unwrap_or(""))), Some("Close"));
        if let Some(a) = act {
            self.prs.split.apply(a);
        }
        if close {
            self.close_prs();
            return;
        }
        if let Some(url) = self.prs.split.current().map(String::from) {
            self.pr_detail(ui, &url);
        }
    }

    fn prs_list(&mut self, ui: &mut Ui, panel: bool) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        self.prs.ctx = Some(ctx.clone());
        // Picking another State refetches: GitHub applies that filter.
        if !self.prs.loading && self.prs.fetched.is_some_and(|s| s != self.prs.filters.state) {
            self.load_prs();
        }
        let projects = self.pr_projects();
        self.prs.filters.project = self.prs.project.and_then(|id| projects.iter().find(|p| p.0 == id).map(|p| p.2.clone()));

        // ---- title bar
        ui.add_space(10.0);
        ui.horizontal(|ui| {
            ui.set_height(32.0);
            ui.add_space(if self.sidebar_docked(&ctx) { 20.0 } else { 52.0 });
            ui.label(egui::RichText::new("Pull Requests").font(FontId::new(15.0, theme::medium())).color(t.fg()));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(12.0);
                ui.spacing_mut().item_spacing.x = 6.0;
                // With the panel open, its header has these.
                if !panel {
                    if w::btn(ic::X).muted().icon_sm().show(ui).on_hover_text("Close").clicked() {
                        self.close_prs();
                    }
                    if let Some(a) = crate::listdetail::toggle_btn(ui, &self.prs.split) {
                        self.prs.split.apply(a);
                    }
                }
            });
        });

        // ---- toolbar
        ui.add_space(12.0);
        let data = self.prs.data.clone();
        let fetched = data.as_ref().and_then(|d| d.as_ref().ok()).cloned().unwrap_or_default();
        centered(ui, 1180.0, |ui| {
            // Beside the side panel the buttons wrap under the search, as in T3 Code.
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(8.0, 8.0);
                let active = self.prs.filters.active(self.prs.filters.project.is_some());
                let sort_w = 12.0 + 16.0 + 8.0 + 34.0 + 14.0;
                let filt_w = 12.0 + 16.0 + 8.0 + 46.0 + if active > 0 { 30.0 } else { 0.0 } + 14.0;
                let rest = sort_w + filt_w + 36.0 * 2.0 + 8.0 * 4.0 + 2.0;
                let search_w = if ui.available_width() - rest < 240.0 { ui.available_width() - 2.0 } else { ui.available_width() - rest };
                let focused = ui.memory(|m| m.has_focus(Id::NULL.with("pr-search")));
                Frame::new()
                    .fill(t.bg100)
                    .stroke(Stroke::new(1.0, if focused { t.gray(700) } else { t.border() }))
                    .corner_radius(CornerRadius::same(RADIUS_MD))
                    .inner_margin(Margin { left: 4, right: 4, top: 2, bottom: 2 })
                    .show(ui, |ui| {
                        ui.set_width(search_w - 10.0);
                        w::search_field(ui, &mut self.prs.search, "Search pull requests, or label:bug", Some(Id::NULL.with("pr-search")), search_w - 18.0);
                    });
                let menu = self.prs.menu;
                let r = tool_btn(ui, ic::ARROW_DOWN_UP, "Sort", None, menu == Some(Menu::Sort)).on_hover_text("Sort pull requests");
                if r.clicked() {
                    self.toggle_pr_menu(Menu::Sort, r.rect);
                }
                let r = tool_btn(ui, ic::FILTER, "Filters", Some(active), menu == Some(Menu::Filters));
                if r.clicked() {
                    self.toggle_pr_menu(Menu::Filters, r.rect);
                }
                let r = tool_btn(ui, "github", "", None, menu == Some(Menu::Provider)).on_hover_text("Filter by provider");
                if r.clicked() {
                    self.toggle_pr_menu(Menu::Provider, r.rect);
                }
                let (rr, rect) = {
                    let r = tool_btn(ui, if self.prs.loading { "" } else { ic::REFRESH }, "", None, false).on_hover_text("Refresh");
                    let rect = r.rect;
                    (r, rect)
                };
                if self.prs.loading {
                    w::spinner(ui.painter(), rect.center(), 6.5, t.subtle());
                    ctx.request_repaint();
                }
                if rr.clicked() && !self.prs.loading {
                    self.load_prs();
                }
            });
        });
        ui.add_space(10.0);

        // ---- list
        let groups = groups(&fetched, &self.prs.filters, &self.prs.search, self.prs.sort);
        let mut open_url = None;
        let mut browse = None;
        let mut action = None;
        ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            centered(ui, 1180.0, |ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                match &data {
                    None => {
                        ui.add_space(24.0);
                        ui.horizontal(|ui| {
                            ui.add_space(16.0);
                            ui.spinner();
                            w::subtle(ui, "Loading pull requests…", "label-14");
                        });
                    }
                    Some(Err(e)) => empty(ui, ic::ALERT, "Couldn't load pull requests", e),
                    Some(Ok(_)) if groups.is_empty() => {
                        let filtered = !self.prs.search.trim().is_empty() || self.prs.filters.active(self.prs.filters.project.is_some()) > 0;
                        if filtered {
                            empty(ui, ic::PR_OPEN, "No pull requests match", "Try another search or clear some filters.");
                        } else {
                            empty(ui, ic::PR_OPEN, "No pull requests", "PRs you open, are asked to review, or that are in your projects' GitHub repos show up here.");
                        }
                    }
                    Some(Ok(_)) => {
                        for g in &groups {
                            if !g.label.is_empty() {
                                section(ui, g.icon, g.label, g.items.len());
                            } else {
                                ui.add_space(6.0);
                            }
                            for p in &g.items {
                                let avatar = self.prs.avatars.get(&p.author).and_then(|a| a.clone());
                                let selected = self.prs.split.current() == Some(p.url.as_str());
                                let resp = row(ui, p, avatar.as_ref(), selected);
                                if resp.clicked() {
                                    open_url = Some(p.url.clone());
                                }
                                let proj = projects.iter().find(|x| x.2.eq_ignore_ascii_case(&p.repo)).map(|x| x.0);
                                resp.context_menu(|ui| {
                                    if ui.button(format!("{}  Open in side panel", ic::PANEL_RIGHT)).clicked() {
                                        open_url = Some(p.url.clone());
                                        ui.close();
                                    }
                                    if ui.button(format!("{}  Open in Harbor's browser", ic::GLOBE)).clicked() {
                                        browse = Some(p.url.clone());
                                        ui.close();
                                    }
                                    if ui.button(format!("{}  Open on GitHub", ic::EXTERNAL)).clicked() {
                                        crate::git::open_url(&p.url);
                                        ui.close();
                                    }
                                    if ui.button(format!("{}  Copy link", ic::COPY)).clicked() {
                                        ui.ctx().copy_text(p.url.clone());
                                        ui.close();
                                    }
                                    if let Some(id) = proj {
                                        ui.separator();
                                        if ui.button(format!("{}  Check out", ic::BRANCH)).clicked() {
                                            action = Some((id, p.clone(), false));
                                            ui.close();
                                        }
                                        if ui.button(format!("{}  Review with an agent", ic::SPARKLES)).clicked() {
                                            action = Some((id, p.clone(), true));
                                            ui.close();
                                        }
                                    }
                                });
                            }
                            ui.add_space(14.0);
                        }
                    }
                }
                ui.add_space(24.0);
            });
        });
        if let Some(url) = open_url {
            self.prs.split.select(&url);
        }
        if let Some(url) = browse {
            self.open_browser(Some(url));
        }
        if let Some((id, p, review)) = action {
            let Some(repo) = self.repo(id).cloned() else { return };
            if review {
                self.new_draft(Some(id));
                self.drafts.insert(
                    crate::app::DRAFT,
                    format!("Review PR #{} ({}). Read it with `gh pr view {0}` and `gh pr diff {0}`, then list concrete problems by severity.", p.number, p.title),
                );
            } else {
                let argv = vec!["gh".into(), "pr".into(), "checkout".into(), p.number.to_string()];
                self.open_terminal(&ctx, &format!("checkout #{}", p.number), repo.path.clone(), argv, vec![]);
            }
        }

        self.pr_menus(&ctx, &fetched, &projects);
    }

    fn toggle_pr_menu(&mut self, m: Menu, anchor: Rect) {
        self.prs.sub = None;
        self.prs.keys = Default::default();
        self.prs.sub_keys = None;
        if self.prs.menu == Some(m) {
            self.prs.menu = None;
        } else {
            self.prs.menu = Some(m);
            self.prs.menu_anchor = Some(anchor);
        }
    }

    fn pr_menus(&mut self, ctx: &egui::Context, data: &Fetched, projects: &[(i64, String, String)]) {
        use crate::listdetail::{self as ld, MenuKey};
        let Some(menu) = self.prs.menu else { return };
        let t = self.theme.t;
        let anchor = self.prs.menu_anchor.unwrap_or(Rect::NOTHING);
        let pos = anchor.left_bottom() + Vec2::new(0.0, 6.0);
        let mut close = false;
        let mut sub_rect = Rect::NOTHING;
        // Keys: ↑↓ Home End move, Enter/Space pick, → opens a filter's submenu
        // and moves into it, ← comes back, Esc closes.
        let main_id = match menu {
            Menu::Sort => "pr-sort",
            Menu::Provider => "pr-provider",
            Menu::Filters => "pr-filters",
        };
        let (mut main_pick, mut main_moved, mut sub_pick, mut sub_moved, mut enter_sub) = (None, false, None, false, false);
        match self.prs.sub_keys.filter(|_| self.prs.sub.is_some()) {
            Some(mut k) => {
                let before = k.hl;
                match k.input(ctx, ld::rows_count(ctx, "pr-sub")) {
                    Some(MenuKey::Pick(i)) => sub_pick = Some(i),
                    Some(MenuKey::Leave) => {
                        self.prs.sub = None;
                        self.prs.sub_keys = None;
                    }
                    Some(MenuKey::Close) => close = true,
                    _ => {}
                }
                sub_moved = k.hl != before;
                if self.prs.sub_keys.is_some() {
                    self.prs.sub_keys = Some(k);
                }
            }
            None => {
                let mut k = self.prs.keys;
                let before = k.hl;
                match k.input(ctx, ld::rows_count(ctx, main_id)) {
                    Some(MenuKey::Pick(i)) => {
                        main_pick = Some(i);
                        enter_sub = menu == Menu::Filters;
                    }
                    Some(MenuKey::Enter(i)) if menu == Menu::Filters => {
                        main_pick = Some(i);
                        enter_sub = true;
                    }
                    Some(MenuKey::Close) => close = true,
                    _ => {}
                }
                main_moved = k.hl != before;
                self.prs.keys = k;
            }
        }
        ld::rows_begin(ctx, self.prs.keys.hl, main_pick, main_moved);
        let main_rect = match menu {
            Menu::Sort => {
                let cur = self.prs.sort;
                let (pick, rect) = float(ctx, "pr-sort", pos, 210.0, &t, |ui| {
                    let mut pick = None;
                    for s in Sort::ALL {
                        if menu_row(ui, s.icon(), s.label(), None, false, false, s == cur).clicked() {
                            pick = Some(s);
                        }
                    }
                    pick
                });
                if let Some(s) = pick {
                    self.prs.sort = s;
                    close = true;
                }
                rect
            }
            Menu::Provider => {
                let gh = self.prs.github_only;
                let (pick, rect) = float(ctx, "pr-provider", pos, 180.0, &t, |ui| {
                    let mut pick = None;
                    if menu_row(ui, ic::LAYERS, "All", None, false, !gh, false).clicked() {
                        pick = Some(false);
                    }
                    let r = menu_row(ui, " ", "GitHub", None, false, gh, false);
                    let mark = Rect::from_center_size(pos2(r.rect.left() + 16.0, r.rect.center().y), Vec2::splat(15.0));
                    crate::logos::paint(ui, ui.painter(), mark, "github", &t);
                    if r.clicked() {
                        pick = Some(true);
                    }
                    pick
                });
                if let Some(g) = pick {
                    self.prs.github_only = g;
                    close = true;
                }
                rect
            }
            Menu::Filters => {
                let f = self.prs.filters.clone();
                let project_name = self.prs.project.and_then(|id| projects.iter().find(|p| p.0 == id)).map(|p| p.1.clone());
                let author = f.author.clone().unwrap_or_else(|| "Anyone".into());
                let labels_v = if f.labels.is_empty() { "Any".to_string() } else { format!("{} selected", f.labels.len()) };
                let sub = self.prs.sub;
                let (hover, rect) = float(ctx, "pr-filters", pos, 250.0, &t, |ui| {
                    let mut hover = None;
                    let mut item = |ui: &mut Ui, s: Sub, icon: &str, label: &str, value: &str| {
                        let r = menu_row(ui, icon, label, Some(value), true, false, sub == Some(s));
                        if r.hovered() || r.clicked() {
                            hover = Some((s, r.rect));
                        }
                    };
                    item(ui, Sub::State, ic::PR_OPEN, "State", name_of(&STATES, f.state));
                    item(ui, Sub::Involvement, ic::LAYERS, "Involvement", name_of(&INVOLVEMENTS, f.involvement));
                    menu_sep(ui);
                    item(ui, Sub::Author, ic::USER_ROUND, "Author", &author);
                    item(ui, Sub::Labels, ic::TAG, "Labels", &labels_v);
                    item(ui, Sub::Draft, ic::LAYERS, "Draft", name_of(&DRAFTS, f.draft));
                    item(ui, Sub::Review, ic::LAYERS, "Review", name_of(&REVIEWS, f.review));
                    item(ui, Sub::Checks, ic::LAYERS, "Checks", name_of(&CHECKS, f.checks));
                    menu_sep(ui);
                    item(ui, Sub::Project, ic::LAYERS, "Project", project_name.as_deref().unwrap_or("All projects"));
                    hover
                });
                ld::rows_end(ctx, main_id);
                if let Some((s, r)) = hover {
                    if self.prs.sub != Some(s) {
                        self.prs.sub_keys = None;
                    }
                    self.prs.sub = Some(s);
                    self.prs.sub_anchor = Some(r);
                }
                if enter_sub && self.prs.sub.is_some() {
                    self.prs.sub_keys = Some(ld::MenuKeys { hl: Some(0) });
                    sub_moved = true;
                }
                if let Some(s) = self.prs.sub {
                    ld::rows_begin(ctx, self.prs.sub_keys.and_then(|k| k.hl), sub_pick, sub_moved);
                    let (done, r) = self.pr_submenu(ctx, s, data, projects);
                    ld::rows_end(ctx, "pr-sub");
                    sub_rect = r;
                    close |= done;
                }
                rect
            }
        };
        let outside = ctx.input(|i| {
            i.pointer.any_pressed() && i.pointer.interact_pos().is_some_and(|p| !main_rect.contains(p) && !sub_rect.contains(p) && !anchor.contains(p))
        });
        if menu != Menu::Filters {
            ld::rows_end(ctx, main_id);
        }
        if close || outside {
            self.prs.menu = None;
            self.prs.sub = None;
            self.prs.keys = Default::default();
            self.prs.sub_keys = None;
        }
    }

    /// One Filters submenu; returns (close the menus, its rect).
    fn pr_submenu(&mut self, ctx: &egui::Context, s: Sub, data: &Fetched, projects: &[(i64, String, String)]) -> (bool, Rect) {
        let t = self.theme.t;
        let a = self.prs.sub_anchor.unwrap_or(Rect::NOTHING);
        let f = &mut self.prs.filters;
        fn radio<T: PartialEq + Copy>(ui: &mut Ui, opts: &[(T, &str, &str)], cur: T) -> Option<T> {
            let mut pick = None;
            for (v, label, icon) in opts {
                if menu_row(ui, icon, label, None, false, *v == cur, false).clicked() {
                    pick = Some(*v);
                }
            }
            pick
        }
        match s {
            Sub::State => {
                let (p, r) = float(ctx, "pr-sub", sub_pos(ctx, a, 190.0), 190.0, &t, |ui| radio(ui, &STATES, f.state));
                if let Some(v) = p {
                    f.state = v;
                }
                (p.is_some(), r)
            }
            Sub::Involvement => {
                let (p, r) = float(ctx, "pr-sub", sub_pos(ctx, a, 190.0), 190.0, &t, |ui| radio(ui, &INVOLVEMENTS, f.involvement));
                if let Some(v) = p {
                    f.involvement = v;
                }
                (p.is_some(), r)
            }
            Sub::Draft => {
                let (p, r) = float(ctx, "pr-sub", sub_pos(ctx, a, 190.0), 190.0, &t, |ui| radio(ui, &DRAFTS, f.draft));
                if let Some(v) = p {
                    f.draft = v;
                }
                (p.is_some(), r)
            }
            Sub::Review => {
                let (p, r) = float(ctx, "pr-sub", sub_pos(ctx, a, 210.0), 210.0, &t, |ui| radio(ui, &REVIEWS, f.review));
                if let Some(v) = p {
                    f.review = v;
                }
                (p.is_some(), r)
            }
            Sub::Checks => {
                let (p, r) = float(ctx, "pr-sub", sub_pos(ctx, a, 190.0), 190.0, &t, |ui| radio(ui, &CHECKS, f.checks));
                if let Some(v) = p {
                    f.checks = v;
                }
                (p.is_some(), r)
            }
            Sub::Author => {
                let list = authors(data);
                let cur = f.author.clone();
                let avatars = &self.prs.avatars;
                let (p, r) = float(ctx, "pr-sub", sub_pos(ctx, a, 220.0), 220.0, &t, |ui| {
                    let mut pick = None;
                    if menu_row(ui, ic::USERS, "Anyone", None, false, cur.is_none(), false).clicked() {
                        pick = Some(None);
                    }
                    if !list.is_empty() {
                        menu_sep(ui);
                    }
                    ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                        for (login, n) in &list {
                            let checked = cur.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(login));
                            let r = menu_row(ui, " ", login, Some(&n.to_string()), false, checked, false);
                            let c = pos2(r.rect.left() + 16.0, r.rect.center().y);
                            paint_avatar(ui.painter(), c, 8.0, avatars.get(login).and_then(|a| a.as_ref()), login, &t);
                            if r.clicked() {
                                pick = Some(Some(login.clone()));
                            }
                        }
                    });
                    pick
                });
                let done = p.is_some();
                if let Some(v) = p {
                    f.author = v;
                }
                (done, r)
            }
            Sub::Labels => {
                let list = labels(data);
                let (p, r) = float(ctx, "pr-sub", sub_pos(ctx, a, 230.0), 230.0, &t, |ui| {
                    let mut toggle = None;
                    if menu_row(ui, ic::TAG, "Any", None, false, f.labels.is_empty(), false).clicked() {
                        f.labels.clear();
                    }
                    if list.is_empty() {
                        menu_sep(ui);
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.add_space(10.0);
                            w::subtle(ui, "No labels in these pull requests.", "label-13");
                        });
                        ui.add_space(6.0);
                    } else {
                        menu_sep(ui);
                    }
                    ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                        for (name, rgb, n) in &list {
                            let checked = f.labels.iter().any(|l| l.eq_ignore_ascii_case(name));
                            let r = menu_row(ui, " ", name, Some(&n.to_string()), false, checked, false);
                            label_dot(ui.painter(), pos2(r.rect.left() + 16.0, r.rect.center().y), *rgb);
                            if r.clicked() {
                                toggle = Some(name.clone());
                            }
                        }
                    });
                    toggle
                });
                if let Some(name) = p {
                    if let Some(i) = f.labels.iter().position(|l| l.eq_ignore_ascii_case(&name)) {
                        f.labels.remove(i);
                    } else {
                        f.labels.push(name);
                    }
                }
                // Several labels can be picked: the menu stays open.
                (false, r)
            }
            Sub::Project => {
                let cur = self.prs.project;
                let (p, r) = float(ctx, "pr-sub", sub_pos(ctx, a, 230.0), 230.0, &t, |ui| {
                    let mut pick = None;
                    if menu_row(ui, ic::LAYERS, "All projects", None, false, cur.is_none(), false).clicked() {
                        pick = Some(None);
                    }
                    ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                        for (id, name, repo) in projects {
                            let r = menu_row(ui, ic::FOLDER_GIT, name, None, false, cur == Some(*id), false).on_hover_text(repo);
                            if r.clicked() {
                                pick = Some(Some(*id));
                            }
                        }
                    });
                    if projects.is_empty() {
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.add_space(10.0);
                            w::subtle(ui, "No projects with a GitHub remote.", "label-13");
                        });
                        ui.add_space(6.0);
                    }
                    pick
                });
                if let Some(v) = p {
                    self.prs.project = v;
                }
                (p.is_some(), r)
            }
        }
    }
}

pub fn empty(ui: &mut Ui, icon: &str, title: &str, desc: &str) {
    let t = w::tokens(ui);
    ui.add_space(64.0);
    ui.vertical_centered(|ui| {
        ui.label(egui::RichText::new(icon).size(28.0).color(t.gray(800)));
        ui.add_space(10.0);
        w::text(ui, title, "heading-16");
        ui.add_space(4.0);
        ui.label(egui::RichText::new(desc).text_style(theme::ts("label-14")).color(t.subtle()));
    });
}

pub fn section(ui: &mut Ui, icon: &str, label: &str, n: usize) {
    let t = w::tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::hover());
    let p = ui.painter();
    let y = rect.center().y;
    ic::glyph(p, pos2(rect.left() + 26.0, y), icon, 15.0, t.gray(800));
    let g = p.layout_no_wrap(label.into(), FontId::proportional(14.0), t.gray(800));
    let x = rect.left() + 42.0;
    let gw = g.size().x;
    p.galley(pos2(x, y - g.size().y / 2.0), g, t.gray(800));
    let c = p.layout_no_wrap(n.to_string(), FontId::proportional(14.0), t.gray(700));
    let cx = x + gw + 10.0;
    let cw = c.size().x;
    p.galley(pos2(cx, y - c.size().y / 2.0), c, t.gray(700));
    p.hline((cx + cw + 10.0)..=(rect.right() - 12.0), y, Stroke::new(1.0, t.border()));
}

pub fn paint_avatar(p: &egui::Painter, c: egui::Pos2, r: f32, tex: Option<&egui::TextureHandle>, login: &str, t: &theme::Tokens) {
    let rect = Rect::from_center_size(c, Vec2::splat(r * 2.0));
    match tex {
        Some(tex) => {
            egui::Image::new((tex.id(), rect.size())).corner_radius(CornerRadius::same(r as u8)).paint_at(&egui::Ui::new(p.ctx().clone(), Id::NULL, egui::UiBuilder::new()), rect);
        }
        None => {
            p.circle_filled(c, r, t.gray(300));
            let ch = login.chars().next().map(|c| c.to_ascii_uppercase().to_string()).unwrap_or_default();
            p.text(c, Align2::CENTER_CENTER, ch, FontId::new(r * 1.1, theme::medium()), t.fg());
        }
    }
}

/// One PR: state icon, #N, title and checks; author and repo below; size and age on the right.
fn row(ui: &mut Ui, p: &Pr, avatar: Option<&egui::TextureHandle>, selected: bool) -> egui::Response {
    let t = w::tokens(ui);
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 62.0), Sense::click());
    if !ui.is_rect_visible(rect) {
        return resp;
    }
    let inner = rect.shrink2(Vec2::new(0.0, 2.0));
    let painter = ui.painter().clone();
    if selected || resp.hovered() {
        painter.rect_filled(inner, CornerRadius::same(RADIUS_MD), if selected { t.accent() } else { alpha(t.accent(), 0.6) });
    }
    let (icon, col, tip) = state_icon(p, &t);
    let top = inner.top() + 19.0;
    let icon_r = Rect::from_center_size(pos2(inner.left() + 26.0, top + 1.0), Vec2::splat(18.0));
    ic::glyph(&painter, icon_r.center(), icon, 17.0, col);
    ui.interact(icon_r, ui.scope_id().with(("pr-state", &p.url)), Sense::hover()).on_hover_text(tip);

    // right column
    let right = inner.right() - 12.0;
    let mono = FontId::new(12.5, egui::FontFamily::Monospace);
    let dels = painter.layout_no_wrap(format!("-{}", thousands(p.dels)), mono.clone(), t.red(900));
    let dx = right - dels.size().x;
    let adds = painter.layout_no_wrap(format!("+{}", thousands(p.adds)), mono, t.green(900));
    let ax = dx - 6.0 - adds.size().x;
    painter.galley(pos2(dx, top - dels.size().y / 2.0), dels, t.red(900));
    painter.galley(pos2(ax, top - adds.size().y / 2.0), adds, t.green(900));
    let age = painter.layout_no_wrap(ago(p.updated), FontId::proportional(12.5), t.subtle());
    let line2 = inner.top() + 42.0;
    painter.galley(pos2(right - age.size().x, line2 - age.size().y / 2.0), age, t.subtle());

    // #N and title
    let x0 = inner.left() + 44.0;
    let num = painter.layout_no_wrap(format!("#{}", p.number), FontId::proportional(13.0), t.gray(800));
    let nw = num.size().x;
    painter.galley(pos2(x0, top - num.size().y / 2.0 - 1.0), num, t.gray(800));
    let tx = x0 + nw + 7.0;
    let max_title = (ax - 40.0 - tx).max(40.0);
    let title = w::truncated(ui, &p.title, FontId::new(15.0, theme::medium()), t.fg(), max_title);
    let tw = title.size().x;
    painter.galley(pos2(tx, top - title.size().y / 2.0), title, t.fg());
    let mut ix = tx + tw + 14.0;
    let check = match p.checks {
        Checks::Passing => Some((ic::CIRCLE_CHECK, t.green(900), "Checks passing")),
        Checks::Failing => Some((ic::CIRCLE_X, t.red(900), "Checks failing")),
        Checks::Pending => Some((ic::CIRCLE_DASHED, t.amber(900), "Checks running")),
        Checks::None => None,
    };
    let review = match p.review {
        Review::Approved => Some((ic::CIRCLE_CHECK, t.blue(900), "Approved")),
        Review::Changes => Some((ic::CIRCLE_SLASH, t.amber(900), "Changes requested")),
        Review::Required | Review::None => None,
    };
    for (g, c, tip) in [check, review].into_iter().flatten() {
        let r = Rect::from_center_size(pos2(ix, top), Vec2::splat(16.0));
        ic::glyph(&painter, r.center(), g, 15.0, c);
        ui.interact(r, ui.scope_id().with((tip, &p.url)), Sense::hover()).on_hover_text(tip);
        ix += 20.0;
    }

    // author, repo, labels
    paint_avatar(&painter, pos2(x0 + 7.0, line2), 7.0, avatar, &p.author, &t);
    let a = painter.layout_no_wrap(p.author.clone(), FontId::proportional(13.0), t.subtle());
    let mut x = x0 + 19.0;
    let aw = a.size().x;
    painter.galley(pos2(x, line2 - a.size().y / 2.0), a, t.subtle());
    x += aw + 8.0;
    let repo = painter.layout_no_wrap(p.repo.to_lowercase(), FontId::proportional(13.0), t.gray(800));
    let rw = repo.size().x;
    painter.galley(pos2(x, line2 - repo.size().y / 2.0), repo, t.gray(800));
    x += rw + 10.0;
    let limit = right - 90.0;
    for (i, (name, rgb)) in p.labels.iter().enumerate() {
        let g = painter.layout_no_wrap(name.clone(), FontId::proportional(11.5), t.fg());
        let w_ = g.size().x + 22.0;
        if x + w_ > limit {
            let more = painter.layout_no_wrap(format!("+{}", p.labels.len() - i), FontId::proportional(11.5), t.subtle());
            painter.galley(pos2(x, line2 - more.size().y / 2.0), more, t.subtle());
            break;
        }
        let r = Rect::from_min_size(pos2(x, line2 - 9.0), Vec2::new(w_, 18.0));
        painter.rect(r, CornerRadius::same(9), Color32::TRANSPARENT, Stroke::new(1.0, t.border()), StrokeKind::Inside);
        label_dot(&painter, pos2(r.left() + 9.0, r.center().y), *rgb);
        painter.galley(pos2(r.left() + 16.0, r.center().y - g.size().y / 2.0), g, t.fg());
        x += w_ + 4.0;
    }
    resp.on_hover_cursor(CursorIcon::PointingHand)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(n: u64, author: &str) -> Pr {
        Pr {
            number: n,
            title: format!("PR {n}"),
            url: format!("https://github.com/o/r/pull/{n}"),
            repo: "o/r".into(),
            state: PrState::Open,
            draft: false,
            adds: n,
            dels: 0,
            created: n as i64,
            updated: n as i64,
            branch: format!("b{n}"),
            review: Review::None,
            checks: Checks::None,
            conflicting: false,
            author: author.into(),
            avatar: String::new(),
            labels: vec![],
            review_requested: false,
        }
    }

    #[test]
    fn query_syntax() {
        let q = parse_query("fix label:bug,ui -label:wontfix author:me draft:true review:approved checks:failing type:feat");
        assert_eq!(q.text, "fix");
        assert_eq!(q.labels, vec![vec!["bug".to_string(), "ui".into()], vec!["type:feat".into()]]);
        assert_eq!(q.excluded, vec!["wontfix".to_string()]);
        assert_eq!(q.author.as_deref(), Some("me"));
        assert_eq!(q.draft, Some(true));
        assert_eq!(q.review, Some(Review::Approved));
        assert_eq!(q.checks, Some(Checks::Failing));
        assert_eq!(parse_query(r#"label:"needs review" x"#).labels, vec![vec!["needs review".to_string()]]);
        assert_eq!(parse_query("https://x").text, "https://x");
    }

    #[test]
    fn iso() {
        assert_eq!(iso_secs("1970-01-02T00:00:01Z"), Some(86401));
        assert_eq!(iso_secs("2026-10-22T00:00:00Z"), Some(1_792_627_200));
    }

    #[test]
    fn grouping_and_filters() {
        let mut a = pr(1, "me");
        a.labels = vec![("bug".into(), [255, 0, 0])];
        let mut b = pr(2, "you");
        b.review_requested = true;
        let c = pr(3, "them");
        let mut d = pr(4, "them");
        d.state = PrState::Merged;
        let data = Fetched { viewer: "Me".into(), items: vec![a, b, c, d] };
        let g = groups(&data, &Filters::default(), "", Sort::Updated);
        let keys: Vec<_> = g.iter().map(|g| (g.key, g.items.len())).collect();
        assert_eq!(keys, vec![("authored", 1), ("reviewRequested", 1), ("others", 1)]);
        let g = groups(&data, &Filters::default(), "label:bug", Sort::Updated);
        assert_eq!(g.len(), 1);
        let f = Filters { state: StateF::All, involvement: Involvement::Reviewing, ..Default::default() };
        let g = groups(&data, &f, "", Sort::Updated);
        assert_eq!(g[0].items[0].number, 2);
        let f = Filters { state: StateF::Merged, ..Default::default() };
        assert_eq!(groups(&data, &f, "", Sort::Updated)[0].items[0].number, 4);
        assert_eq!(groups(&data, &Filters::default(), "#3", Sort::Ready)[0].items[0].number, 3);
    }

    #[test]
    fn sorts() {
        let mut items: Vec<Pr> = (1..=4).map(|n| pr(n, "x")).collect();
        items[0].checks = Checks::Passing;
        items[0].review = Review::Approved;
        items[3].conflicting = true;
        sort_group(&mut items, "others", Sort::Ready, "", Involvement::All);
        assert_eq!(items.first().unwrap().number, 1);
        assert_eq!(items.last().unwrap().number, 4);
        sort_group(&mut items, "others", Sort::Largest, "", Involvement::All);
        assert_eq!(items[0].number, 4);
        sort_group(&mut items, "others", Sort::Oldest, "", Involvement::All);
        assert_eq!(items[0].number, 1);
    }

    #[test]
    fn remotes() {
        assert_eq!(github_repo("https://github.com/RDevNeo/harbor").as_deref(), Some("RDevNeo/harbor"));
        assert_eq!(github_repo("https://gitlab.com/a/b"), None);
    }
}
