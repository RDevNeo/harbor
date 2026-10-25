//! Issues page, the Pull requests page's sibling: every issue assigned to
//! you, that you opened or that mentions you, plus the ones in your projects'
//! GitHub repos, fetched with the GitHub CLI and grouped (Assigned / Authored /
//! Mentioned / Others). Search (with `label:` and friends), sort and filters
//! run on the fetched list; a row opens the issue in the side panel. The
//! toolbar, menus, rows and the list/panel split are shared with prs.rs and
//! listdetail.rs.

use crate::app::{App, Bg, View};
use crate::chat::centered;
use crate::icons as ic;
use crate::listdetail::{self as ld, MenuKeys, Split};
use crate::prs::{self, Tool, ago, float, iso_secs, menu_row, menu_sep, name_of, paint_avatar, radio, sub_pos};
use crate::theme::{self, RADIUS_MD};
use crate::widgets::{self as w, alpha};
use eframe::egui::{self, Color32, CornerRadius, CursorIcon, FontId, Id, Rect, ScrollArea, Sense, Ui, Vec2, pos2};
use std::collections::{HashMap, HashSet};

// ------------------------------------------------------------------ model

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum IssueState {
    Open,
    /// Closed as completed.
    Done,
    /// Closed as not planned (or as a duplicate).
    NotPlanned,
}

#[derive(Clone, Debug)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// owner/name
    pub repo: String,
    pub state: IssueState,
    pub created: i64,
    pub updated: i64,
    pub comments: u64,
    pub author: String,
    pub avatar: String,
    pub labels: Vec<(String, [u8; 3])>,
    pub assignees: Vec<String>,
    pub milestone: Option<String>,
    /// It mentions the viewer.
    pub mentioned: bool,
    /// An open pull request says it fixes it.
    pub linked_pr: bool,
    /// Its author is the repo's owner, a member of its organisation or a collaborator
    /// (GitHub's authorAssociation): only such issues are fixed unattended.
    pub author_trusted: bool,
}

#[derive(Clone, Default)]
pub struct Fetched {
    pub viewer: String,
    pub items: Vec<Issue>,
}

#[derive(Clone, Copy, PartialEq, Default, Debug)]
pub enum Sort {
    #[default]
    Updated,
    Stale,
    Newest,
    Oldest,
    MostCommented,
    LeastCommented,
}

impl Sort {
    const ALL: [Sort; 6] = [Sort::Updated, Sort::Stale, Sort::Newest, Sort::Oldest, Sort::MostCommented, Sort::LeastCommented];

    pub fn label(self) -> &'static str {
        match self {
            Sort::Updated => "Recently updated",
            Sort::Stale => "Least recently updated",
            Sort::Newest => "Newest",
            Sort::Oldest => "Oldest",
            Sort::MostCommented => "Most commented",
            Sort::LeastCommented => "Least commented",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Sort::Updated | Sort::Stale => ic::CLOCK,
            Sort::Newest => ic::CALENDAR_DOWN,
            Sort::Oldest => ic::CALENDAR_UP,
            Sort::MostCommented | Sort::LeastCommented => ic::MESSAGE,
        }
    }
}

/// The State filter; GitHub applies it (the others run here).
#[derive(Clone, Copy, PartialEq, Default, Debug)]
pub enum StateF {
    All,
    #[default]
    Open,
    Closed,
}

#[derive(Clone, Copy, PartialEq, Default, Debug)]
pub enum Involvement {
    #[default]
    All,
    Assigned,
    Authored,
    Mentioned,
}

/// The Assignee filter: nobody, or someone.
#[derive(Clone, PartialEq, Debug)]
pub enum Assignee {
    Nobody,
    Login(String),
}

#[derive(Clone, Default, PartialEq)]
pub struct Filters {
    pub state: StateF,
    pub involvement: Involvement,
    pub author: Option<String>,
    pub assignee: Option<Assignee>,
    /// Every label must be on the issue.
    pub labels: Vec<String>,
    /// Some(None): issues without a milestone.
    pub milestone: Option<Option<String>>,
    /// owner/name of the picked project's repo.
    pub project: Option<String>,
}

impl Filters {
    /// The count on the Filters button: everything not at its default.
    fn active(&self) -> usize {
        [
            self.state != StateF::Open,
            self.involvement != Involvement::All,
            self.project.is_some(),
            self.author.is_some(),
            self.assignee.is_some(),
            self.milestone.is_some(),
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
    Assignee,
    Labels,
    Milestone,
    Project,
}

#[derive(Default)]
pub struct Issues {
    /// Where the close button goes.
    pub back: Option<View>,
    pub loading: bool,
    generation: u64,
    pub data: Option<Result<std::sync::Arc<Fetched>, String>>,
    /// The page's sections for (list, filters, search, sort).
    groups: crate::listdetail::Memo<(crate::listdetail::Same<Fetched>, Filters, String, Sort), Vec<Group>>,
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
    keys: MenuKeys,
    sub_keys: Option<MenuKeys>,
    /// The issues open as tabs in the side panel (keyed by URL).
    pub split: Split,
    pub details: HashMap<String, crate::issuedetail::Detail>,
}

// ------------------------------------------------------------------ fetching

const FIELDS: &str = "... on Issue { number title url state stateReason createdAt updatedAt repository { nameWithOwner } \
author { login avatarUrl(size: 40) } authorAssociation labels(first: 10) { nodes { name color } } assignees(first: 10) { nodes { login } } \
milestone { title } comments { totalCount } closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { state } } }";

fn state_qualifier(s: StateF) -> &'static str {
    match s {
        StateF::All => "",
        StateF::Open => " is:open",
        StateF::Closed => " is:closed",
    }
}

/// The GraphQL query: issues assigned to you, that you opened, that mention
/// you, and the ones in the given repos (chunked: search caps a query's length).
fn query(state: StateF, repos: &[String]) -> String {
    let st = state_qualifier(state);
    let mut q = String::from("query { viewer { login } ");
    let mut search = |alias: &str, s: &str, n: u32| {
        let s = s.replace('\\', "").replace('"', "");
        q.push_str(&format!("{alias}: search(query: \"{s}\", type: ISSUE, first: {n}) {{ nodes {{ {FIELDS} }} }} "));
    };
    search("assigned", &format!("is:issue assignee:@me archived:false sort:updated-desc{st}"), 50);
    search("authored", &format!("is:issue author:@me archived:false sort:updated-desc{st}"), 50);
    search("mentioned", &format!("is:issue mentions:@me archived:false sort:updated-desc{st}"), 50);
    for (i, chunk) in repos.chunks(5).enumerate() {
        let rs: Vec<String> = chunk.iter().map(|r| format!("repo:{r}")).collect();
        search(&format!("p{i}"), &format!("is:issue sort:updated-desc{st} {}", rs.join(" ")), 100);
    }
    q.push('}');
    q
}

pub fn fetch(state: StateF, repos: &[String]) -> Result<Fetched, String> {
    prs::graphql(&query(state, repos), "issues").map(|v| parse(&v))
}

fn parse(v: &serde_json::Value) -> Fetched {
    let d = &v["data"];
    let viewer = d["viewer"]["login"].as_str().unwrap_or("").to_string();
    let mentioned: HashSet<String> =
        d["mentioned"]["nodes"].as_array().into_iter().flatten().filter_map(|n| n["url"].as_str().map(String::from)).collect();
    let mut seen = HashSet::new();
    let mut items = vec![];
    let mut aliases: Vec<&String> = d.as_object().map(|o| o.keys().filter(|k| *k != "viewer").collect()).unwrap_or_default();
    aliases.sort();
    for a in aliases {
        for n in d[a]["nodes"].as_array().into_iter().flatten() {
            let Some(i) = node(n) else { continue };
            if seen.insert(i.url.clone()) {
                items.push(Issue { mentioned: mentioned.contains(&i.url), ..i });
            }
        }
    }
    items.sort_by(|a, b| b.updated.cmp(&a.updated));
    Fetched { viewer, items }
}

fn node(n: &serde_json::Value) -> Option<Issue> {
    let s = |k: &str| n[k].as_str().unwrap_or("").to_string();
    let url = n["url"].as_str()?.to_string();
    Some(Issue {
        number: n["number"].as_u64()?,
        title: s("title"),
        url,
        repo: n["repository"]["nameWithOwner"].as_str().unwrap_or("").to_string(),
        state: state_of(n["state"].as_str().unwrap_or(""), n["stateReason"].as_str().unwrap_or("")),
        created: iso_secs(&s("createdAt")).unwrap_or(0),
        updated: iso_secs(&s("updatedAt")).unwrap_or(0),
        comments: n["comments"]["totalCount"].as_u64().unwrap_or(0),
        author: n["author"]["login"].as_str().unwrap_or("ghost").to_string(),
        avatar: n["author"]["avatarUrl"].as_str().unwrap_or("").to_string(),
        labels: n["labels"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| Some((l["name"].as_str()?.to_string(), prs::hex_rgb(l["color"].as_str().unwrap_or("")))))
            .collect(),
        assignees: n["assignees"]["nodes"].as_array().into_iter().flatten().filter_map(|a| a["login"].as_str().map(String::from)).collect(),
        milestone: n["milestone"]["title"].as_str().map(String::from),
        mentioned: false,
        linked_pr: n["closedByPullRequestsReferences"]["nodes"].as_array().into_iter().flatten().any(|p| p["state"].as_str() == Some("OPEN")),
        author_trusted: crate::autowork::trusted(n["authorAssociation"].as_str().unwrap_or("")),
    })
}

/// GitHub's state and stateReason ("OPEN", "CLOSED" + "COMPLETED" / "NOT_PLANNED" / "DUPLICATE").
pub fn state_of(state: &str, reason: &str) -> IssueState {
    match (state.to_ascii_uppercase().as_str(), reason.to_ascii_uppercase().as_str()) {
        ("OPEN", _) => IssueState::Open,
        (_, "NOT_PLANNED" | "DUPLICATE") => IssueState::NotPlanned,
        _ => IssueState::Done,
    }
}

// ------------------------------------------------------------------ search, filters, sort

/// The search box: the PR page's syntax (`label:`, `-label:`, `author:`, free
/// text) plus `assignee:` (`assignee:none` or `no:assignee` for unassigned)
/// and `milestone:` (`no:milestone`).
#[derive(Default, Debug, PartialEq)]
pub struct Query {
    pub base: prs::Query,
    pub assignee: Option<Assignee>,
    pub milestone: Option<Option<String>>,
}

pub fn parse_query(s: &str) -> Query {
    let mut q = Query::default();
    let mut rest = vec![];
    for tok in s.split_whitespace() {
        let lower = tok.to_lowercase();
        if lower == "no:assignee" {
            q.assignee = Some(Assignee::Nobody);
        } else if lower == "no:milestone" {
            q.milestone = Some(None);
        } else if let Some(v) = lower.strip_prefix("assignee:").filter(|v| !v.is_empty()) {
            q.assignee = Some(if v == "none" { Assignee::Nobody } else { Assignee::Login(tok[9..].trim_start_matches('@').to_string()) });
        } else if let Some(v) = tok.get(10..).filter(|v| lower.starts_with("milestone:") && !v.is_empty()) {
            let v = v.trim_matches('"');
            q.milestone = Some((!v.eq_ignore_ascii_case("none")).then(|| v.to_string()));
        } else {
            rest.push(tok);
        }
    }
    q.base = prs::parse_query(&rest.join(" "));
    q
}

pub struct Group {
    /// assigned / authored / mentioned / others (the tests check it).
    #[allow(dead_code)]
    pub key: &'static str,
    pub label: &'static str,
    pub icon: &'static str,
    pub items: Vec<Issue>,
}

fn is(login: &str, viewer: &str) -> bool {
    !viewer.is_empty() && login.eq_ignore_ascii_case(viewer)
}

fn assigned(i: &Issue, viewer: &str) -> bool {
    i.assignees.iter().any(|a| is(a, viewer))
}

fn passes(i: &Issue, f: &Filters, q: &Query) -> bool {
    let has = |l: &str| i.labels.iter().any(|(n, _)| n.trim().eq_ignore_ascii_case(l.trim()));
    let state = match f.state {
        StateF::All => true,
        StateF::Open => i.state == IssueState::Open,
        StateF::Closed => i.state != IssueState::Open,
    };
    let author = q.base.author.as_ref().or(f.author.as_ref());
    let assignee = q.assignee.as_ref().or(f.assignee.as_ref());
    let milestone = q.milestone.as_ref().or(f.milestone.as_ref());
    state
        && f.project.as_ref().is_none_or(|r| i.repo.eq_ignore_ascii_case(r))
        && author.is_none_or(|a| i.author.eq_ignore_ascii_case(a.trim_start_matches('@')))
        && assignee.is_none_or(|a| match a {
            Assignee::Nobody => i.assignees.is_empty(),
            Assignee::Login(l) => i.assignees.iter().any(|x| x.eq_ignore_ascii_case(l)),
        })
        && milestone.is_none_or(|m| match (m, &i.milestone) {
            (None, x) => x.is_none(),
            (Some(want), Some(have)) => want.eq_ignore_ascii_case(have),
            (Some(_), None) => false,
        })
        && f.labels.iter().all(|l| has(l))
        && q.base.labels.iter().all(|any| any.iter().any(|l| has(l)))
        && !q.base.excluded.iter().any(|l| has(l))
}

fn matches_text(i: &Issue, text: &str) -> bool {
    let n = text.trim().to_lowercase();
    n.is_empty() || format!("#{} {} {} {}", i.number, i.title, i.repo, i.author).to_lowercase().contains(&n)
}

/// How well an issue matches the free text (the PR page's ranking, without branches).
fn relevance(i: &Issue, text: &str) -> u32 {
    let n = text.trim().to_lowercase();
    let num = n.trim_start_matches('#');
    if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
        return if i.number.to_string() == num { 100 } else { 0 };
    }
    let title = i.title.to_lowercase();
    let words: Vec<&str> = n.split_whitespace().collect();
    if title == n {
        90
    } else if title.contains(&n) {
        80
    } else if words.len() > 1 && words.iter().all(|w| title.contains(w)) {
        70
    } else if i.author.to_lowercase().contains(&n) {
        50
    } else if i.repo.to_lowercase().contains(&n) {
        40
    } else if words.iter().any(|w| title.contains(w)) {
        30
    } else {
        10
    }
}

fn sort_group(items: &mut [Issue], sort: Sort, text: &str) {
    let text = text.trim();
    if !text.is_empty() && sort == Sort::Updated {
        items.sort_by(|a, b| relevance(b, text).cmp(&relevance(a, text)).then(b.updated.cmp(&a.updated)));
        return;
    }
    match sort {
        Sort::Updated => items.sort_by(|a, b| b.updated.cmp(&a.updated)),
        Sort::Stale => items.sort_by(|a, b| a.updated.cmp(&b.updated)),
        Sort::Newest => items.sort_by(|a, b| b.created.cmp(&a.created).then(b.updated.cmp(&a.updated))),
        Sort::Oldest => items.sort_by(|a, b| a.created.cmp(&b.created).then(b.updated.cmp(&a.updated))),
        Sort::MostCommented => items.sort_by(|a, b| b.comments.cmp(&a.comments).then(b.updated.cmp(&a.updated))),
        Sort::LeastCommented => items.sort_by(|a, b| a.comments.cmp(&b.comments).then(b.updated.cmp(&a.updated))),
    }
}

/// The page's sections, filtered and sorted. An issue sits in the first
/// section it fits: Assigned, Authored, Mentioned, then Others.
pub fn groups(data: &Fetched, f: &Filters, search: &str, sort: Sort) -> Vec<Group> {
    let q = parse_query(search);
    let viewer = data.viewer.as_str();
    let items = data.items.iter().filter(|i| match f.involvement {
        Involvement::All => true,
        Involvement::Assigned => assigned(i, viewer),
        Involvement::Authored => is(&i.author, viewer),
        Involvement::Mentioned => i.mentioned,
    });
    let items: Vec<Issue> = items.filter(|i| passes(i, f, &q) && matches_text(i, &q.base.text)).cloned().collect();
    let mut out = if f.involvement != Involvement::All {
        vec![Group { key: "others", label: "", icon: "", items }]
    } else {
        let (mut a, mut b, mut m, mut o) = (vec![], vec![], vec![], vec![]);
        for i in items {
            if assigned(&i, viewer) {
                a.push(i)
            } else if is(&i.author, viewer) {
                b.push(i)
            } else if i.mentioned {
                m.push(i)
            } else {
                o.push(i)
            }
        }
        vec![
            Group { key: "assigned", label: "Assigned", icon: ic::USER_CHECK, items: a },
            Group { key: "authored", label: "Authored", icon: ic::PEN_LINE, items: b },
            Group { key: "mentioned", label: "Mentioned", icon: ic::AT_SIGN, items: m },
            Group { key: "others", label: "Others", icon: ic::USERS, items: o },
        ]
    };
    out.retain(|g| !g.items.is_empty());
    for g in &mut out {
        sort_group(&mut g.items, sort, &q.base.text);
    }
    out
}

/// Each value in the list with how many issues have it, most first.
fn tally<'a>(it: impl Iterator<Item = &'a str>) -> Vec<(String, usize)> {
    let mut m: HashMap<String, usize> = HashMap::new();
    for v in it {
        *m.entry(v.to_string()).or_default() += 1;
    }
    let mut v: Vec<_> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    v
}

pub fn authors(data: &Fetched) -> Vec<(String, usize)> {
    tally(data.items.iter().map(|i| i.author.as_str()))
}

pub fn assignees(data: &Fetched) -> Vec<(String, usize)> {
    tally(data.items.iter().flat_map(|i| i.assignees.iter().map(String::as_str)))
}

pub fn milestones(data: &Fetched) -> Vec<(String, usize)> {
    tally(data.items.iter().filter_map(|i| i.milestone.as_deref()))
}

pub fn labels(data: &Fetched) -> Vec<(String, [u8; 3], usize)> {
    let mut m: HashMap<String, ([u8; 3], usize)> = HashMap::new();
    for i in &data.items {
        for (n, c) in &i.labels {
            m.entry(n.clone()).or_insert((*c, 0)).1 += 1;
        }
    }
    let mut v: Vec<_> = m.into_iter().map(|(n, (c, k))| (n, c, k)).collect();
    v.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    v
}

// ------------------------------------------------------------------ app glue

impl App {
    pub fn open_issues(&mut self, project: Option<i64>) {
        if self.view != View::Issues {
            self.issues.back = Some(self.view);
        }
        if project.is_some() {
            self.issues.project = project;
        }
        self.open(View::Issues);
    }

    pub fn close_issues(&mut self) {
        let v = match self.issues.back.take() {
            Some(View::Chat(id)) if self.chat(id).is_none() => View::Draft,
            Some(View::Issues) | None => View::Draft,
            Some(v) => v,
        };
        self.open(v);
    }

    pub fn load_issues(&mut self) {
        let repos = self.gh_repos();
        self.issues.generation += 1;
        self.issues.loading = true;
        let (generation, state) = (self.issues.generation, self.issues.filters.state);
        let tx = self.bg_tx.clone();
        let ctx = self.prs.ctx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Bg::Issues(generation, state, fetch(state, &repos())));
            if let Some(c) = ctx {
                c.request_repaint();
            }
        });
    }

    pub fn issues_loaded(&mut self, generation: u64, state: StateF, r: Result<Fetched, String>) {
        if generation != self.issues.generation {
            return;
        }
        self.issues.loading = false;
        let same = self.issues.fetched == Some(state);
        self.issues.fetched = Some(state);
        // A failed refresh keeps the list it had.
        if r.is_err() && same && matches!(self.issues.data, Some(Ok(_))) {
            return;
        }
        if let Ok(f) = &r {
            self.fetch_avatars(f.items.iter().map(|i| (i.author.clone(), i.avatar.clone())));
        }
        self.issues.data = Some(r.map(std::sync::Arc::new));
    }
}

// ------------------------------------------------------------------ ui

/// Why the agent actions are off for a repo that isn't a Harbor project.
pub const NOT_PROJECT: &str = "Add this repo as a Harbor project to let an agent work on it";

fn done_color(t: &theme::Tokens) -> Color32 {
    if t.dark { Color32::from_rgb(196, 181, 253) } else { Color32::from_rgb(124, 58, 237) }
}

/// GitHub's issue marks: open (green dot), completed (purple check), not planned (grey slash).
pub fn state_icon(s: IssueState, t: &theme::Tokens) -> (&'static str, Color32, &'static str) {
    match s {
        IssueState::Open => (ic::CIRCLE_DOT, t.green(900), "Open"),
        IssueState::Done => (ic::CIRCLE_CHECK, done_color(t), "Closed as completed"),
        IssueState::NotPlanned => (ic::CIRCLE_SLASH, t.gray(800), "Closed as not planned"),
    }
}

const STATES: [(StateF, &str, &str); 3] = [(StateF::All, "All", ic::LAYERS), (StateF::Open, "Open", ic::CIRCLE_DOT), (StateF::Closed, "Closed", ic::CIRCLE_CHECK)];
const INVOLVEMENTS: [(Involvement, &str, &str); 4] = [
    (Involvement::All, "All", ic::LAYERS),
    (Involvement::Assigned, "Assigned", ic::USER_CHECK),
    (Involvement::Authored, "Authored", ic::PEN_LINE),
    (Involvement::Mentioned, "Mentioned", ic::AT_SIGN),
];

impl App {
    /// The page: the list, and beside it the side panel with the issues opened
    /// as tabs (see listdetail.rs). Esc leaves the page.
    pub fn issues_view(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        let typing = ctx.text_edit_focused();
        let had_menu = self.issues.menu.is_some();
        if let Some(ld::Shortcut::Tab(a)) = ld::shortcuts(&ctx, &self.keys, &self.issues.split, Id::NULL.with("issue-search")) {
            self.issues.split.apply(a);
        }
        let rect = ui.available_rect_before_wrap();
        let (list, panel) = ld::areas(ui, Id::NULL.with("issue-split"), &mut self.issues.split, rect);
        match list {
            Some(r) => ld::region(ui, r, |ui| self.issues_list(ui, panel.is_some())),
            None => self.issues.menu = None,
        }
        if let Some(r) = panel {
            ld::region(ui, r, |ui| self.issue_panel(ui));
        }
        ui.allocate_rect(rect, Sense::hover());
        let split = &self.issues.split;
        self.issues.details.retain(|k, _| split.tabs.contains(k));
        if !had_menu && self.issues.menu.is_none() && self.dialog.is_none() && self.popup.is_none() && ld::esc_leaves(&ctx, typing) {
            self.close_issues();
        }
    }

    /// The side panel: a tab per opened issue, its controls, and the issue on show.
    fn issue_panel(&mut self, ui: &mut Ui) {
        ui.add_space(10.0);
        let (act, close) = ld::header(ui, &self.issues.split, |url| (ic::CIRCLE_DOT, format!("#{}", url.rsplit('/').next().unwrap_or(""))), Some("Close"));
        if let Some(a) = act {
            self.issues.split.apply(a);
        }
        if close {
            self.close_issues();
            return;
        }
        if let Some(url) = self.issues.split.current().map(String::from) {
            self.issue_detail(ui, &url);
        }
    }

    fn issues_list(&mut self, ui: &mut Ui, panel: bool) {
        let ctx = ui.ctx().clone();
        self.prs.ctx = Some(ctx.clone());
        // Picking another State refetches: GitHub applies that filter.
        if !self.issues.loading && self.issues.fetched.is_some_and(|s| s != self.issues.filters.state) {
            self.load_issues();
        }
        let projects = self.pr_projects();
        self.issues.filters.project = self.issues.project.and_then(|id| projects.iter().find(|p| p.0 == id).map(|p| p.2.clone()));

        let (close, tab) = prs::list_title(ui, "Issues", self.sidebar_docked(&ctx), panel, &self.issues.split);
        if close {
            self.close_issues();
        }
        if let Some(a) = tab {
            self.issues.split.apply(a);
        }

        let data = self.issues.data.clone();
        let fetched = data.as_ref().and_then(|d| d.as_ref().ok()).cloned().unwrap_or_default();
        let active = self.issues.filters.active();
        let open = self.issues.menu.map(|m| match m {
            Menu::Sort => Tool::Sort,
            Menu::Filters => Tool::Filters,
            Menu::Provider => Tool::Provider,
        });
        match prs::toolbar(ui, &mut self.issues.search, "Search issues, or label:bug", Id::NULL.with("issue-search"), active, open, self.issues.loading) {
            Some((Tool::Sort, r)) => self.toggle_issue_menu(Menu::Sort, r),
            Some((Tool::Filters, r)) => self.toggle_issue_menu(Menu::Filters, r),
            Some((Tool::Provider, r)) => self.toggle_issue_menu(Menu::Provider, r),
            Some((Tool::Refresh, _)) => self.load_issues(),
            None => {}
        }

        let key = (crate::listdetail::Same(fetched.clone()), self.issues.filters.clone(), self.issues.search.clone(), self.issues.sort);
        let groups = self.issues.groups.get(key, || groups(&fetched, &self.issues.filters, &self.issues.search, self.issues.sort));
        let mut open_url = None;
        let mut browse = None;
        let mut work = None;
        let fix_label = format!("Fix with {}", self.agent_label());
        ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            centered(ui, 1180.0, |ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                match &data {
                    None => {
                        ui.add_space(24.0);
                        ui.horizontal(|ui| {
                            ui.add_space(16.0);
                            w::busy(ui);
                            w::subtle(ui, "Loading issues…", "label-14");
                        });
                    }
                    Some(Err(e)) => prs::empty(ui, ic::ALERT, "Couldn't load issues", e),
                    Some(Ok(_)) if groups.is_empty() => {
                        if !self.issues.search.trim().is_empty() || active > 0 {
                            prs::empty(ui, ic::CIRCLE_DOT, "No issues match", "Try another search or clear some filters.");
                        } else {
                            prs::empty(ui, ic::CIRCLE_DOT, "No issues", "Issues assigned to you, that you open or that mention you, and those in your projects' GitHub repos show up here.");
                        }
                    }
                    Some(Ok(_)) => {
                        for g in groups.iter() {
                            if !g.label.is_empty() {
                                prs::section(ui, g.icon, g.label, g.items.len());
                            } else {
                                ui.add_space(6.0);
                            }
                            for i in &g.items {
                                let avatar = self.prs.avatars.get(&i.author).and_then(|a| a.clone());
                                let selected = self.issues.split.current() == Some(i.url.as_str());
                                let resp = row(ui, i, avatar.as_ref(), selected);
                                if resp.clicked() {
                                    open_url = Some(i.url.clone());
                                }
                                let proj = projects.iter().find(|x| x.2.eq_ignore_ascii_case(&i.repo)).map(|x| x.0);
                                resp.context_menu(|ui| {
                                    if ui.button(format!("{}  Open in side panel", ic::PANEL_RIGHT)).clicked() {
                                        open_url = Some(i.url.clone());
                                        ui.close();
                                    }
                                    if ui.button(format!("{}  Open in Harbor's browser", ic::GLOBE)).clicked() {
                                        browse = Some(i.url.clone());
                                        ui.close();
                                    }
                                    if ui.button(format!("{}  Open on GitHub", ic::EXTERNAL)).clicked() {
                                        crate::git::open_url(&i.url);
                                        ui.close();
                                    }
                                    if ui.button(format!("{}  Copy link", ic::COPY)).clicked() {
                                        ui.ctx().copy_text(i.url.clone());
                                        ui.close();
                                    }
                                    ui.separator();
                                    let b = ui.add_enabled(proj.is_some() && i.state == IssueState::Open, egui::Button::new(format!("{}  {fix_label}", ic::SPARKLES)));
                                    if b.on_disabled_hover_text(NOT_PROJECT).clicked() {
                                        work = proj.map(|id| (id, i.clone(), false));
                                        ui.close();
                                    }
                                    let b = ui.add_enabled(proj.is_some() && i.state == IssueState::Open, egui::Button::new(format!("{}  Fix with instructions…", ic::PEN_LINE)));
                                    if b.on_disabled_hover_text(NOT_PROJECT).clicked() {
                                        work = proj.map(|id| (id, i.clone(), true));
                                        ui.close();
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
            self.issues.split.select(&url);
        }
        if let Some(url) = browse {
            self.open_browser(Some(url));
        }
        if let Some((id, i, ask)) = work {
            if ask {
                self.ask_instructions(id, crate::autowork::Job::Fix(i));
            } else {
                self.fix_issue(&ctx, id, &i, "");
            }
        }

        self.issue_menus(&ctx, &fetched, &projects);
    }

    fn toggle_issue_menu(&mut self, m: Menu, anchor: Rect) {
        let s = &mut self.issues;
        s.sub = None;
        s.keys = Default::default();
        s.sub_keys = None;
        if s.menu == Some(m) {
            s.menu = None;
        } else {
            s.menu = Some(m);
            s.menu_anchor = Some(anchor);
        }
    }

    fn issue_menus(&mut self, ctx: &egui::Context, data: &Fetched, projects: &[(i64, String, String)]) {
        let Some(menu) = self.issues.menu else { return };
        let t = self.theme.t;
        let anchor = self.issues.menu_anchor.unwrap_or(Rect::NOTHING);
        let pos = anchor.left_bottom() + Vec2::new(0.0, 6.0);
        let mut close = false;
        let mut sub_rect = Rect::NOTHING;
        let main_id = match menu {
            Menu::Sort => "issue-sort",
            Menu::Provider => "issue-provider",
            Menu::Filters => "issue-filters",
        };
        let k = ld::menu_keys(ctx, &mut self.issues.keys, &mut self.issues.sub_keys, self.issues.sub.is_some(), main_id, "issue-sub", menu == Menu::Filters);
        if k.leave {
            self.issues.sub = None;
        }
        let mut sub_moved = k.sub_moved;
        close |= k.close;
        ld::rows_begin(ctx, self.issues.keys.hl, k.main_pick, k.main_moved);
        let main_rect = match menu {
            Menu::Sort => {
                let cur = self.issues.sort;
                let (pick, rect) = float(ctx, "issue-sort", pos, 220.0, &t, |ui| {
                    let mut pick = None;
                    for s in Sort::ALL {
                        if menu_row(ui, s.icon(), s.label(), None, false, false, s == cur).clicked() {
                            pick = Some(s);
                        }
                    }
                    pick
                });
                if let Some(s) = pick {
                    self.issues.sort = s;
                    close = true;
                }
                rect
            }
            Menu::Provider => {
                let (pick, rect) = prs::provider_menu(ctx, "issue-provider", pos, &t, self.issues.github_only);
                if let Some(g) = pick {
                    self.issues.github_only = g;
                    close = true;
                }
                rect
            }
            Menu::Filters => {
                let f = self.issues.filters.clone();
                let project_name = self.issues.project.and_then(|id| projects.iter().find(|p| p.0 == id)).map(|p| p.1.clone());
                let author = f.author.clone().unwrap_or_else(|| "Anyone".into());
                let assignee = match &f.assignee {
                    None => "Anyone".to_string(),
                    Some(Assignee::Nobody) => "Nobody".into(),
                    Some(Assignee::Login(l)) => l.clone(),
                };
                let labels_v = if f.labels.is_empty() { "Any".to_string() } else { format!("{} selected", f.labels.len()) };
                let milestone = match &f.milestone {
                    None => "Any".to_string(),
                    Some(None) => "None".into(),
                    Some(Some(m)) => m.clone(),
                };
                let sub = self.issues.sub;
                let (hover, rect) = float(ctx, "issue-filters", pos, 250.0, &t, |ui| {
                    let mut hover = None;
                    let mut item = |ui: &mut Ui, s: Sub, icon: &str, label: &str, value: &str| {
                        let r = menu_row(ui, icon, label, Some(value), true, false, sub == Some(s));
                        if r.hovered() || r.clicked() {
                            hover = Some((s, r.rect));
                        }
                    };
                    item(ui, Sub::State, ic::CIRCLE_DOT, "State", name_of(&STATES, f.state));
                    item(ui, Sub::Involvement, ic::LAYERS, "Involvement", name_of(&INVOLVEMENTS, f.involvement));
                    menu_sep(ui);
                    item(ui, Sub::Author, ic::USER_ROUND, "Author", &author);
                    item(ui, Sub::Assignee, ic::USER_CHECK, "Assignee", &assignee);
                    item(ui, Sub::Labels, ic::TAG, "Labels", &labels_v);
                    item(ui, Sub::Milestone, ic::MILESTONE, "Milestone", &milestone);
                    menu_sep(ui);
                    item(ui, Sub::Project, ic::FOLDER_GIT, "Project", project_name.as_deref().unwrap_or("All projects"));
                    hover
                });
                ld::rows_end(ctx, main_id);
                if let Some((s, r)) = hover {
                    if self.issues.sub != Some(s) {
                        self.issues.sub_keys = None;
                    }
                    self.issues.sub = Some(s);
                    self.issues.sub_anchor = Some(r);
                }
                if k.enter_sub && self.issues.sub.is_some() {
                    self.issues.sub_keys = Some(MenuKeys { hl: Some(0) });
                    sub_moved = true;
                }
                if let Some(s) = self.issues.sub {
                    ld::rows_begin(ctx, self.issues.sub_keys.and_then(|k| k.hl), k.sub_pick, sub_moved);
                    let (done, r) = self.issue_submenu(ctx, s, data, projects);
                    ld::rows_end(ctx, "issue-sub");
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
            let s = &mut self.issues;
            s.menu = None;
            s.sub = None;
            s.keys = Default::default();
            s.sub_keys = None;
        }
    }

    /// One Filters submenu; returns (close the menus, its rect).
    fn issue_submenu(&mut self, ctx: &egui::Context, s: Sub, data: &Fetched, projects: &[(i64, String, String)]) -> (bool, Rect) {
        let t = self.theme.t;
        let a = self.issues.sub_anchor.unwrap_or(Rect::NOTHING);
        let avatars = &self.prs.avatars;
        let f = &mut self.issues.filters;
        // A list of people (with avatars) after "Anyone" and, for assignees, "Nobody".
        let people = |ui: &mut Ui, list: &[(String, usize)], cur: Option<&str>, nobody: Option<bool>| {
            let mut pick: Option<Option<Option<String>>> = None;
            if menu_row(ui, ic::USERS, "Anyone", None, false, cur.is_none() && nobody != Some(true), false).clicked() {
                pick = Some(None);
            }
            if let Some(on) = nobody {
                if menu_row(ui, ic::CIRCLE_SLASH, "Nobody", None, false, on, false).clicked() {
                    pick = Some(Some(None));
                }
            }
            if !list.is_empty() {
                menu_sep(ui);
            }
            ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                for (login, n) in list {
                    let checked = cur.is_some_and(|c| c.eq_ignore_ascii_case(login));
                    let r = menu_row(ui, " ", login, Some(&n.to_string()), false, checked, false);
                    paint_avatar(ui.painter(), pos2(r.rect.left() + 16.0, r.rect.center().y), 8.0, avatars.get(login).and_then(|a| a.as_ref()), login, &t);
                    if r.clicked() {
                        pick = Some(Some(Some(login.clone())));
                    }
                }
            });
            pick
        };
        let note = |ui: &mut Ui, text: &str| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.add_space(10.0);
                w::subtle(ui, text, "label-13");
            });
            ui.add_space(6.0);
        };
        match s {
            Sub::State => {
                let (p, r) = float(ctx, "issue-sub", sub_pos(ctx, a, 190.0), 190.0, &t, |ui| radio(ui, &STATES, f.state));
                if let Some(v) = p {
                    f.state = v;
                }
                (p.is_some(), r)
            }
            Sub::Involvement => {
                let (p, r) = float(ctx, "issue-sub", sub_pos(ctx, a, 190.0), 190.0, &t, |ui| radio(ui, &INVOLVEMENTS, f.involvement));
                if let Some(v) = p {
                    f.involvement = v;
                }
                (p.is_some(), r)
            }
            Sub::Author => {
                let list = authors(data);
                let cur = f.author.clone();
                let (p, r) = float(ctx, "issue-sub", sub_pos(ctx, a, 220.0), 220.0, &t, |ui| people(ui, &list, cur.as_deref(), None));
                if let Some(v) = &p {
                    f.author = v.clone().flatten();
                }
                (p.is_some(), r)
            }
            Sub::Assignee => {
                let list = assignees(data);
                let cur = match &f.assignee {
                    Some(Assignee::Login(l)) => Some(l.clone()),
                    _ => None,
                };
                let nobody = f.assignee == Some(Assignee::Nobody);
                let (p, r) = float(ctx, "issue-sub", sub_pos(ctx, a, 220.0), 220.0, &t, |ui| people(ui, &list, cur.as_deref(), Some(nobody)));
                if let Some(v) = &p {
                    f.assignee = match v {
                        None => None,
                        Some(None) => Some(Assignee::Nobody),
                        Some(Some(l)) => Some(Assignee::Login(l.clone())),
                    };
                }
                (p.is_some(), r)
            }
            Sub::Labels => {
                let list = labels(data);
                let (p, r) = float(ctx, "issue-sub", sub_pos(ctx, a, 230.0), 230.0, &t, |ui| {
                    let mut toggle = None;
                    if menu_row(ui, ic::TAG, "Any", None, false, f.labels.is_empty(), false).clicked() {
                        f.labels.clear();
                    }
                    menu_sep(ui);
                    if list.is_empty() {
                        note(ui, "No labels in these issues.");
                    }
                    ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                        for (name, rgb, n) in &list {
                            let checked = f.labels.iter().any(|l| l.eq_ignore_ascii_case(name));
                            let r = menu_row(ui, " ", name, Some(&n.to_string()), false, checked, false);
                            prs::label_dot(ui.painter(), pos2(r.rect.left() + 16.0, r.rect.center().y), *rgb);
                            if r.clicked() {
                                toggle = Some(name.clone());
                            }
                        }
                    });
                    toggle
                });
                if let Some(name) = p {
                    match f.labels.iter().position(|l| l.eq_ignore_ascii_case(&name)) {
                        Some(i) => {
                            f.labels.remove(i);
                        }
                        None => f.labels.push(name),
                    }
                }
                // Several labels can be picked: the menu stays open.
                (false, r)
            }
            Sub::Milestone => {
                let list = milestones(data);
                let cur = f.milestone.clone();
                let (p, r) = float(ctx, "issue-sub", sub_pos(ctx, a, 230.0), 230.0, &t, |ui| {
                    let mut pick = None;
                    if menu_row(ui, ic::LAYERS, "Any", None, false, cur.is_none(), false).clicked() {
                        pick = Some(None);
                    }
                    if menu_row(ui, ic::CIRCLE_SLASH, "No milestone", None, false, cur == Some(None), false).clicked() {
                        pick = Some(Some(None));
                    }
                    menu_sep(ui);
                    if list.is_empty() {
                        note(ui, "No milestones in these issues.");
                    }
                    ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                        for (m, n) in &list {
                            let checked = cur.as_ref().and_then(|c| c.as_deref()).is_some_and(|c| c.eq_ignore_ascii_case(m));
                            if menu_row(ui, ic::MILESTONE, m, Some(&n.to_string()), false, checked, false).clicked() {
                                pick = Some(Some(Some(m.clone())));
                            }
                        }
                    });
                    pick
                });
                if let Some(v) = &p {
                    f.milestone = v.clone();
                }
                (p.is_some(), r)
            }
            Sub::Project => {
                let cur = self.issues.project;
                let (p, r) = float(ctx, "issue-sub", sub_pos(ctx, a, 230.0), 230.0, &t, |ui| {
                    let mut pick = None;
                    if menu_row(ui, ic::LAYERS, "All projects", None, false, cur.is_none(), false).clicked() {
                        pick = Some(None);
                    }
                    ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                        for (id, name, repo) in projects {
                            if menu_row(ui, ic::FOLDER_GIT, name, None, false, cur == Some(*id), false).on_hover_text(repo).clicked() {
                                pick = Some(Some(*id));
                            }
                        }
                    });
                    if projects.is_empty() {
                        note(ui, "No projects with a GitHub remote.");
                    }
                    pick
                });
                if let Some(v) = p {
                    self.issues.project = v;
                }
                (p.is_some(), r)
            }
        }
    }
}

/// One issue: state icon, #N and title; author, repo and labels below;
/// comments and age on the right.
fn row(ui: &mut Ui, i: &Issue, avatar: Option<&egui::TextureHandle>, selected: bool) -> egui::Response {
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
    let (icon, col, tip) = state_icon(i.state, &t);
    let top = inner.top() + 19.0;
    let icon_r = Rect::from_center_size(pos2(inner.left() + 26.0, top + 1.0), Vec2::splat(18.0));
    ic::glyph(&painter, icon_r.center(), icon, 17.0, col);
    ui.interact(icon_r, ui.scope_id().with(("issue-state", &i.url)), Sense::hover()).on_hover_text(tip);

    // right column: comments, then age
    let right = inner.right() - 12.0;
    let mut cx = right;
    if i.comments > 0 {
        let n = painter.layout_no_wrap(i.comments.to_string(), FontId::proportional(13.0), t.subtle());
        cx -= n.size().x;
        painter.galley(pos2(cx, top - n.size().y / 2.0), n, t.subtle());
        cx -= 11.0;
        ic::glyph(&painter, pos2(cx, top), ic::MESSAGE, 14.0, t.subtle());
        cx -= 9.0;
    }
    let line2 = inner.top() + 42.0;
    let age = painter.layout_no_wrap(ago(i.updated), FontId::proportional(12.5), t.subtle());
    painter.galley(pos2(right - age.size().x, line2 - age.size().y / 2.0), age, t.subtle());

    // #N and title
    let x0 = inner.left() + 44.0;
    let num = painter.layout_no_wrap(format!("#{}", i.number), FontId::proportional(13.0), t.gray(800));
    let nw = num.size().x;
    painter.galley(pos2(x0, top - num.size().y / 2.0 - 1.0), num, t.gray(800));
    let tx = x0 + nw + 7.0;
    let title = w::truncated(ui, &i.title, FontId::new(15.0, theme::medium()), t.fg(), (cx - 24.0 - tx).max(40.0));
    painter.galley(pos2(tx, top - title.size().y / 2.0), title, t.fg());

    prs::row_meta(&painter, pos2(x0, line2), right - 90.0, avatar, &i.author, &i.repo, &i.labels, &t);
    resp.on_hover_cursor(CursorIcon::PointingHand)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(n: u64, author: &str) -> Issue {
        Issue {
            number: n,
            title: format!("Issue {n}"),
            url: format!("https://github.com/o/r/issues/{n}"),
            repo: "o/r".into(),
            state: IssueState::Open,
            created: n as i64,
            updated: n as i64,
            comments: 0,
            author: author.into(),
            avatar: String::new(),
            labels: vec![],
            assignees: vec![],
            milestone: None,
            mentioned: false,
            linked_pr: false,
            author_trusted: true,
        }
    }

    #[test]
    fn query_syntax() {
        let q = parse_query("crash label:bug assignee:@me milestone:v1 -label:wontfix");
        assert_eq!(q.base.text, "crash");
        assert_eq!(q.base.labels, vec![vec!["bug".to_string()]]);
        assert_eq!(q.base.excluded, vec!["wontfix".to_string()]);
        assert_eq!(q.assignee, Some(Assignee::Login("me".into())));
        assert_eq!(q.milestone, Some(Some("v1".into())));
        let q = parse_query("no:assignee no:milestone");
        assert_eq!((q.assignee, q.milestone), (Some(Assignee::Nobody), Some(None)));
        assert_eq!(parse_query("assignee:none").assignee, Some(Assignee::Nobody));
    }

    #[test]
    fn states() {
        assert_eq!(state_of("OPEN", ""), IssueState::Open);
        assert_eq!(state_of("CLOSED", "COMPLETED"), IssueState::Done);
        assert_eq!(state_of("CLOSED", "NOT_PLANNED"), IssueState::NotPlanned);
        assert_eq!(state_of("closed", ""), IssueState::Done);
    }

    #[test]
    fn grouping_and_filters() {
        let mut a = issue(1, "you");
        a.assignees = vec!["Me".into()];
        let mut b = issue(2, "me");
        b.labels = vec![("bug".into(), [255, 0, 0])];
        b.milestone = Some("v1".into());
        let mut c = issue(3, "them");
        c.mentioned = true;
        let mut d = issue(4, "them");
        d.state = IssueState::Done;
        d.comments = 9;
        let data = Fetched { viewer: "me".into(), items: vec![a, b, c, d] };
        let keys = |g: Vec<Group>| g.iter().map(|g| (g.key, g.items.len())).collect::<Vec<_>>();
        assert_eq!(keys(groups(&data, &Filters::default(), "", Sort::Updated)), vec![("assigned", 1), ("authored", 1), ("mentioned", 1)]);
        assert_eq!(groups(&data, &Filters::default(), "label:bug", Sort::Updated)[0].items[0].number, 2);
        let all = Filters { state: StateF::All, ..Default::default() };
        assert_eq!(keys(groups(&data, &all, "", Sort::Updated)).last(), Some(&("others", 1)));
        let f = Filters { state: StateF::Closed, ..Default::default() };
        assert_eq!(groups(&data, &f, "", Sort::Updated)[0].items[0].number, 4);
        let f = Filters { involvement: Involvement::Mentioned, ..Default::default() };
        assert_eq!(groups(&data, &f, "", Sort::Updated)[0].items[0].number, 3);
        let f = Filters { assignee: Some(Assignee::Nobody), milestone: Some(Some("V1".into())), ..Default::default() };
        assert_eq!(groups(&data, &f, "", Sort::Updated)[0].items[0].number, 2);
        assert_eq!(groups(&data, &all, "#3", Sort::Updated)[0].items[0].number, 3);
        assert_eq!(milestones(&data), vec![("v1".to_string(), 1)]);
    }

    #[test]
    fn sorts() {
        let mut items: Vec<Issue> = (1..=4).map(|n| issue(n, "x")).collect();
        items[1].comments = 5;
        sort_group(&mut items, Sort::MostCommented, "");
        assert_eq!(items[0].number, 2);
        sort_group(&mut items, Sort::Oldest, "");
        assert_eq!(items[0].number, 1);
        sort_group(&mut items, Sort::Updated, "");
        assert_eq!(items[0].number, 4);
        sort_group(&mut items, Sort::Stale, "");
        assert_eq!(items[0].number, 1);
    }

    #[test]
    fn parses_search_nodes() {
        let v = serde_json::json!({ "data": {
            "viewer": { "login": "me" },
            "assigned": { "nodes": [] },
            "mentioned": { "nodes": [{ "number": 5, "title": "T", "url": "https://github.com/o/r/issues/5", "state": "CLOSED", "stateReason": "NOT_PLANNED",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-02T00:00:00Z", "repository": { "nameWithOwner": "o/r" },
                "author": { "login": "a", "avatarUrl": "x" }, "labels": { "nodes": [{ "name": "bug", "color": "ff0000" }] },
                "assignees": { "nodes": [{ "login": "b" }] }, "milestone": { "title": "v2" }, "comments": { "totalCount": 3 } }] },
            "p0": { "nodes": [{ "number": 5, "url": "https://github.com/o/r/issues/5" }] }
        }});
        let f = parse(&v);
        assert_eq!(f.items.len(), 1);
        let i = &f.items[0];
        assert!(i.mentioned && i.state == IssueState::NotPlanned && i.comments == 3);
        assert_eq!((i.assignees.clone(), i.milestone.clone()), (vec!["b".to_string()], Some("v2".to_string())));
        assert_eq!(i.labels[0], ("bug".to_string(), [255, 0, 0]));
    }
}
