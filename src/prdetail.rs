//! One pull request in the Pull Requests page's side panel, after T3 Code's:
//! repo and number (a link), title, author, base ← head, the checkout command
//! and the diff size, then Summary (reviewers, labels, description, checks,
//! comments), Timeline (commits, reviews, comments) and Code (the diff) tabs.
//! Actions: Ready for review, Check out, and a ⋯ menu (refresh, review with an
//! agent, open, copy link / number / checkout command).

use crate::app::App;
use crate::autowork::{Go, Job};
use crate::icons as ic;
use crate::prs::{Pr, ago, iso_secs, paint_avatar, thousands};
use crate::theme::{self, RADIUS_MD};
use crate::widgets::{self as w, alpha};
use eframe::egui::{self, Color32, CornerRadius, CursorIcon, FontId, Frame, Id, Margin, RichText, ScrollArea, Sense, Stroke, StrokeKind, Ui, Vec2, pos2};
use egui_commonmark::CommonMarkViewer;
use std::sync::mpsc::{Receiver, Sender, channel};

const FIELDS: &str = "number,title,body,url,state,isDraft,author,createdAt,updatedAt,baseRefName,headRefName,additions,deletions,changedFiles,\
labels,reviewRequests,latestReviews,reviews,comments,statusCheckRollup,commits,mergeable";

#[derive(Clone, Copy, PartialEq, Default)]
pub enum Tab {
    #[default]
    Summary,
    Timeline,
    Code,
}

#[derive(Clone, Copy, PartialEq)]
pub enum CheckState {
    Pass,
    Fail,
    Pending,
    Skipped,
}

#[derive(Clone)]
pub struct Check {
    pub name: String,
    pub state: CheckState,
    pub url: String,
}

#[derive(Clone)]
pub struct Note {
    pub author: String,
    pub at: i64,
    pub body: String,
}

#[derive(Clone)]
pub enum Event {
    Opened,
    Commit { sha: String, headline: String },
    Review { state: String, body: String },
    Comment { body: String },
}

#[derive(Clone)]
pub struct Full {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub created: i64,
    pub updated: i64,
    pub base: String,
    pub head: String,
    pub adds: u64,
    pub dels: u64,
    pub files: u64,
    pub labels: Vec<(String, [u8; 3])>,
    /// (who, review state or "PENDING" for a request)
    pub reviewers: Vec<(String, String)>,
    pub body: String,
    pub checks: Vec<Check>,
    pub comments: Vec<Note>,
    /// (when, who, what), oldest first.
    pub timeline: Vec<(i64, String, Event)>,
    pub conflicting: bool,
}

enum Msg {
    Full(Result<Full, String>),
    Diff(Result<String, String>),
    /// A mutation (ready for review) finished: refresh.
    Done(Result<(), String>),
}

/// One open tab's state.
pub struct Detail {
    pub tab: Tab,
    pub full: Option<Result<Full, String>>,
    pub loading: bool,
    pub diff: Option<Result<Vec<Line>, String>>,
    pub diff_loading: bool,
    pub busy: bool,
    pub error: Option<String>,
    show_checks: bool,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
}

impl Default for Detail {
    fn default() -> Self {
        let (tx, rx) = channel();
        Detail { tab: Tab::Summary, full: None, loading: false, diff: None, diff_loading: false, busy: false, error: None, show_checks: false, tx, rx }
    }
}

pub fn gh(args: &[&str]) -> Result<Vec<u8>, String> {
    let out = std::process::Command::new("gh").args(args).env("PATH", crate::providers::child_path()).output().map_err(|e| format!("gh: {e}"))?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if e.is_empty() { "gh failed".into() } else { e });
    }
    Ok(out.stdout)
}

fn fetch(url: &str) -> Result<Full, String> {
    let out = gh(&["pr", "view", url, "--json", FIELDS])?;
    let v: serde_json::Value = serde_json::from_slice(&out).map_err(|e| e.to_string())?;
    Ok(parse(&v))
}

fn login(v: &serde_json::Value) -> String {
    v["login"].as_str().or(v["name"].as_str()).unwrap_or("ghost").to_string()
}

fn parse(v: &serde_json::Value) -> Full {
    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let arr = |k: &str| v[k].as_array().cloned().unwrap_or_default();
    let ts = |x: &serde_json::Value, k: &str| x[k].as_str().and_then(iso_secs).unwrap_or(0);
    let color = |c: &str| {
        let h = |i: usize| c.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok()).unwrap_or(128);
        [h(0), h(2), h(4)]
    };
    let mut reviewers: Vec<(String, String)> = vec![];
    for r in arr("latestReviews") {
        let who = login(&r["author"]);
        if !reviewers.iter().any(|x| x.0 == who) {
            reviewers.push((who, r["state"].as_str().unwrap_or("").to_string()));
        }
    }
    for r in arr("reviewRequests") {
        let who = r["login"].as_str().or(r["slug"].as_str()).or(r["name"].as_str()).unwrap_or("").to_string();
        if !who.is_empty() && !reviewers.iter().any(|x| x.0 == who) {
            reviewers.push((who, "PENDING".into()));
        }
    }
    let checks = arr("statusCheckRollup")
        .iter()
        .map(|c| {
            let name = c["name"].as_str().or(c["context"].as_str()).unwrap_or("check").to_string();
            let url = c["detailsUrl"].as_str().or(c["targetUrl"].as_str()).unwrap_or("").to_string();
            let concl = c["conclusion"].as_str().or(c["state"].as_str()).unwrap_or("");
            let status = c["status"].as_str().unwrap_or("COMPLETED");
            let state = match (status, concl) {
                (_, "SUCCESS") => CheckState::Pass,
                (_, "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE") => CheckState::Fail,
                (_, "SKIPPED" | "NEUTRAL" | "STALE") => CheckState::Skipped,
                _ => CheckState::Pending,
            };
            Check { name, state, url }
        })
        .collect();
    let comments: Vec<Note> = arr("comments").iter().map(|c| Note { author: login(&c["author"]), at: ts(c, "createdAt"), body: clean_md(c["body"].as_str().unwrap_or("")) }).collect();
    let mut timeline = vec![(ts(v, "createdAt"), login(&v["author"]), Event::Opened)];
    for c in arr("commits") {
        let who = c["authors"][0]["login"].as_str().or(c["authors"][0]["name"].as_str()).unwrap_or("").to_string();
        let sha: String = c["oid"].as_str().unwrap_or("").chars().take(7).collect();
        timeline.push((ts(&c, "committedDate"), who, Event::Commit { sha, headline: c["messageHeadline"].as_str().unwrap_or("").to_string() }));
    }
    for r in arr("reviews") {
        timeline.push((
            ts(&r, "submittedAt"),
            login(&r["author"]),
            Event::Review { state: r["state"].as_str().unwrap_or("").to_string(), body: clean_md(r["body"].as_str().unwrap_or("")) },
        ));
    }
    for c in &comments {
        timeline.push((c.at, c.author.clone(), Event::Comment { body: c.body.clone() }));
    }
    timeline.sort_by_key(|e| e.0);
    Full {
        number: v["number"].as_u64().unwrap_or(0),
        title: s("title"),
        url: s("url"),
        state: s("state"),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        author: login(&v["author"]),
        created: ts(v, "createdAt"),
        updated: ts(v, "updatedAt"),
        base: s("baseRefName"),
        head: s("headRefName"),
        adds: v["additions"].as_u64().unwrap_or(0),
        dels: v["deletions"].as_u64().unwrap_or(0),
        files: v["changedFiles"].as_u64().unwrap_or(0),
        labels: arr("labels").iter().filter_map(|l| Some((l["name"].as_str()?.to_string(), color(l["color"].as_str().unwrap_or(""))))).collect(),
        reviewers,
        body: clean_md(&s("body")),
        checks,
        comments,
        timeline,
        conflicting: v["mergeable"].as_str() == Some("CONFLICTING"),
    }
}

/// GitHub renders HTML in descriptions and comments; the markdown viewer
/// doesn't. Drops `<!-- comments -->` and common tags (keeping their text),
/// outside code.
pub fn clean_md(s: &str) -> String {
    const TAGS: [&str; 18] = ["div", "a", "img", "picture", "source", "br", "p", "span", "details", "summary", "sub", "sup", "b", "i", "em", "strong", "hr", "center"];
    let mut out = String::with_capacity(s.len());
    let mut fenced = false;
    let mut in_comment = false;
    for line in s.split_inclusive('\n') {
        if !in_comment && line.trim_start().starts_with("```") {
            fenced = !fenced;
            out.push_str(line);
            continue;
        }
        if fenced {
            out.push_str(line);
            continue;
        }
        let mut rest = line;
        let mut code = false;
        while !rest.is_empty() {
            if in_comment {
                match rest.find("-->") {
                    Some(i) => {
                        rest = &rest[i + 3..];
                        in_comment = false;
                    }
                    None => rest = "",
                }
                continue;
            }
            let c = rest.chars().next().unwrap_or(' ');
            if c == '`' {
                code = !code;
            } else if !code && rest.starts_with("<!--") {
                in_comment = true;
                rest = &rest[4..];
                continue;
            } else if !code && c == '<' {
                let body = rest[1..].trim_start_matches('/');
                let name: String = body.chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
                if let (true, Some(end)) = (TAGS.contains(&name.as_str()), rest.find('>')) {
                    rest = &rest[end + 1..];
                    continue;
                }
            }
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// A diff line, ready to paint.
#[derive(Clone, PartialEq, Debug)]
pub enum Line {
    File { path: String, adds: u64, dels: u64 },
    Hunk(String),
    Add(String),
    Del(String),
    Ctx(String),
}

pub fn parse_diff(d: &str) -> Vec<Line> {
    let mut out = vec![];
    let mut file: Option<usize> = None;
    let mut in_hunk = false;
    for l in d.lines() {
        if let Some(rest) = l.strip_prefix("diff --git ") {
            let path = rest.rsplit_once(" b/").map_or(rest, |x| x.1).to_string();
            out.push(Line::File { path, adds: 0, dels: 0 });
            file = Some(out.len() - 1);
            in_hunk = false;
        } else if l.starts_with("@@") {
            out.push(Line::Hunk(l.to_string()));
            in_hunk = true;
        } else if !in_hunk {
            // index / --- / +++ / mode lines
        } else if let Some(x) = l.strip_prefix('+') {
            out.push(Line::Add(x.to_string()));
            if let Some(Line::File { adds, .. }) = file.and_then(|i| out.get_mut(i)) {
                *adds += 1;
            }
        } else if let Some(x) = l.strip_prefix('-') {
            out.push(Line::Del(x.to_string()));
            if let Some(Line::File { dels, .. }) = file.and_then(|i| out.get_mut(i)) {
                *dels += 1;
            }
        } else if !l.starts_with('\\') {
            out.push(Line::Ctx(l.strip_prefix(' ').unwrap_or(l).to_string()));
        }
    }
    out
}

pub fn ctx_repaint(ctx: &egui::Context) -> impl Fn() + Send + 'static {
    let c = ctx.clone();
    move || c.request_repaint()
}

impl Detail {
    pub fn load(&mut self, ctx: &egui::Context, url: &str) {
        self.loading = true;
        let (tx, url, wake) = (self.tx.clone(), url.to_string(), ctx_repaint(ctx));
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Full(fetch(&url)));
            wake();
        });
    }

    fn load_diff(&mut self, ctx: &egui::Context, url: &str) {
        self.diff_loading = true;
        let (tx, url, wake) = (self.tx.clone(), url.to_string(), ctx_repaint(ctx));
        std::thread::spawn(move || {
            let r = gh(&["pr", "diff", &url]).map(|b| String::from_utf8_lossy(&b).into_owned());
            let _ = tx.send(Msg::Diff(r));
            wake();
        });
    }

    fn ready(&mut self, ctx: &egui::Context, url: &str) {
        self.busy = true;
        let (tx, url, wake) = (self.tx.clone(), url.to_string(), ctx_repaint(ctx));
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Done(gh(&["pr", "ready", &url]).map(|_| ())));
            wake();
        });
    }

    /// Takes finished fetches; true when a mutation finished (the list should refresh too).
    fn poll(&mut self, ctx: &egui::Context, url: &str) -> bool {
        let mut changed = false;
        while let Ok(m) = self.rx.try_recv() {
            match m {
                Msg::Full(r) => {
                    self.loading = false;
                    // A failed refresh keeps what it had.
                    if r.is_ok() || !matches!(self.full, Some(Ok(_))) {
                        self.full = Some(r);
                    }
                }
                Msg::Diff(r) => {
                    self.diff_loading = false;
                    self.diff = Some(r.map(|d| parse_diff(&d)));
                }
                Msg::Done(r) => {
                    self.busy = false;
                    self.error = r.err();
                    self.load(ctx, url);
                    changed = true;
                }
            }
        }
        changed
    }
}

fn review_tone(state: &str, t: &theme::Tokens) -> (&'static str, Color32, &'static str) {
    match state {
        "APPROVED" => (ic::CIRCLE_CHECK, t.green(900), "approved"),
        "CHANGES_REQUESTED" => (ic::CIRCLE_X, t.amber(900), "requested changes"),
        "COMMENTED" => (ic::MESSAGE, t.subtle(), "commented"),
        "DISMISSED" => (ic::CIRCLE_SLASH, t.gray(800), "review dismissed"),
        _ => (ic::CIRCLE_DASHED, t.gray(800), "review requested"),
    }
}

fn check_tone(s: CheckState, t: &theme::Tokens) -> (&'static str, Color32) {
    match s {
        CheckState::Pass => (ic::CIRCLE_CHECK, t.green(900)),
        CheckState::Fail => (ic::CIRCLE_X, t.red(900)),
        CheckState::Pending => (ic::CIRCLE_DASHED, t.amber(900)),
        CheckState::Skipped => (ic::CIRCLE_SLASH, t.gray(800)),
    }
}

/// "All checks passed" and friends, for the tab bar.
fn checks_summary(c: &[Check], t: &theme::Tokens) -> (&'static str, Color32, String) {
    let n = |s| c.iter().filter(|x| x.state == s).count();
    let (fail, pend) = (n(CheckState::Fail), n(CheckState::Pending));
    if c.is_empty() {
        (ic::CIRCLE_DASHED, t.subtle(), "No checks reported".into())
    } else if fail > 0 {
        (ic::CIRCLE_X, t.red(900), format!("{fail} of {} checks failing", c.len()))
    } else if pend > 0 {
        (ic::CIRCLE_DASHED, t.amber(900), format!("{pend} checks running"))
    } else {
        (ic::CIRCLE_CHECK, t.green(900), "All checks passed".into())
    }
}

/// A row of the summary's key/value block (Reviewers, Labels).
pub fn field(ui: &mut Ui, icon: &str, name: &str, add: impl FnOnce(&mut Ui)) {
    let t = w::tokens(ui);
    ui.horizontal(|ui| {
        ui.set_min_height(28.0);
        let (r, _) = ui.allocate_exact_size(Vec2::new(120.0, 20.0), Sense::hover());
        ic::glyph(ui.painter(), pos2(r.left() + 8.0, r.center().y), icon, 15.0, t.subtle());
        ui.painter().text(pos2(r.left() + 24.0, r.center().y), egui::Align2::LEFT_CENTER, name, FontId::proportional(14.0), t.subtle());
        add(ui);
    });
}

pub fn section_toggle(ui: &mut Ui, label: &str, open: bool) -> bool {
    let t = w::tokens(ui);
    let r = ui
        .horizontal(|ui| {
            let r = ui.add(egui::Label::new(RichText::new(label).text_style(theme::ts("label-14")).color(t.subtle())).sense(Sense::click()));
            ui.label(RichText::new(if open { ic::DOWN } else { ic::RIGHT }).size(13.0).color(t.subtle()));
            r
        })
        .inner;
    r.on_hover_cursor(CursorIcon::PointingHand).clicked()
}

pub fn chip(ui: &mut Ui, text: &str, rgb: Option<[u8; 3]>) {
    let t = w::tokens(ui);
    let g = ui.painter().layout_no_wrap(text.to_string(), FontId::proportional(12.5), t.fg());
    let dot = if rgb.is_some() { 12.0 } else { 0.0 };
    let (r, _) = ui.allocate_exact_size(Vec2::new(g.size().x + 16.0 + dot, 22.0), Sense::hover());
    let p = ui.painter();
    p.rect(r, CornerRadius::same(11), Color32::TRANSPARENT, Stroke::new(1.0, t.border()), StrokeKind::Inside);
    if let Some(c) = rgb {
        crate::prs::label_dot(p, pos2(r.left() + 11.0, r.center().y), c);
    }
    p.galley(pos2(r.left() + 8.0 + dot, r.center().y - g.size().y / 2.0), g, t.fg());
}

impl App {
    /// The panel body for the PR at `url` (`list` is its row, shown while the rest loads).
    pub fn pr_detail(&mut self, ui: &mut Ui, url: &str) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        let d = self.prs.details.entry(url.to_string()).or_default();
        if d.full.is_none() && !d.loading {
            d.load(&ctx, url);
        }
        if d.poll(&ctx, url) {
            self.load_prs();
        }
        let list: Option<Pr> = self.prs.data.as_ref().and_then(|d| d.as_ref().ok()).and_then(|f| f.items.iter().find(|p| p.url == url).cloned());
        let Some(d) = self.prs.details.get(url) else { return };
        let full = d.full.as_ref().and_then(|f| f.as_ref().ok()).cloned();
        let err = match &d.full {
            Some(Err(e)) => Some(e.clone()),
            _ => d.error.clone(),
        };
        let (loading, busy, tab) = (d.loading, d.busy, d.tab);

        // What we know, from the full fetch or else the list row.
        let number = full.as_ref().map(|f| f.number).or(list.as_ref().map(|p| p.number)).unwrap_or(0);
        let title = full.as_ref().map(|f| f.title.clone()).or(list.as_ref().map(|p| p.title.clone())).unwrap_or_default();
        let repo = list.as_ref().map(|p| p.repo.clone()).unwrap_or_else(|| repo_of(full.as_ref().map_or(url, |f| f.url.as_str())));
        let author = full.as_ref().map(|f| f.author.clone()).or(list.as_ref().map(|p| p.author.clone())).unwrap_or_default();
        let updated = full.as_ref().map(|f| f.updated).or(list.as_ref().map(|p| p.updated)).unwrap_or(0);
        let draft = full.as_ref().map(|f| f.draft).or(list.as_ref().map(|p| p.draft)).unwrap_or(false);
        let open = full.as_ref().map_or(list.as_ref().is_none_or(|p| p.state == crate::prs::PrState::Open), |f| f.state == "OPEN");
        let project = self.pr_projects().into_iter().find(|p| p.2.eq_ignore_ascii_case(&repo)).map(|p| p.0);
        let checkout = format!("gh pr checkout {number}");

        let mut act: Option<Act> = None;
        // ---- header
        Frame::new().inner_margin(Margin { left: 20, right: 16, top: 6, bottom: 10 }).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let r = ui
                    .add(egui::Label::new(RichText::new(format!("{} #{number}  {}", repo.to_lowercase(), ic::EXTERNAL)).text_style(theme::ts("label-14")).color(t.subtle())).sense(Sense::click()))
                    .on_hover_cursor(CursorIcon::PointingHand)
                    .on_hover_text("Open on GitHub");
                if r.clicked() {
                    act = Some(Act::OpenWeb);
                }
                r.context_menu(|ui| {
                    if ui.button(format!("{}  Copy link", ic::COPY)).clicked() {
                        act = Some(Act::CopyLink);
                        ui.close();
                    }
                    if ui.button(format!("{}  Open on GitHub", ic::EXTERNAL)).clicked() {
                        act = Some(Act::OpenWeb);
                        ui.close();
                    }
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    let more = w::btn("⋯").muted().icon_sm().show(ui).on_hover_text("More actions");
                    egui::Popup::menu(&more).show(|ui| {
                        ui.set_min_width(220.0);
                        if ui.button(format!("{}  Refresh", ic::REFRESH)).clicked() {
                            act = Some(Act::Refresh);
                        }
                        if project.is_some() && ui.button(format!("{}  Review with an agent", ic::SPARKLES)).clicked() {
                            act = Some(Act::Review);
                        }
                        ui.separator();
                        if ui.button(format!("{}  Open in the side browser", ic::GLOBE)).clicked() {
                            act = Some(Act::OpenPane);
                        }
                        if ui.button(format!("{}  Open on GitHub", ic::EXTERNAL)).clicked() {
                            act = Some(Act::OpenWeb);
                        }
                        if ui.button(format!("{}  Copy link   Ctrl+Shift+C", ic::LINK)).clicked() {
                            act = Some(Act::CopyLink);
                        }
                        if ui.button(format!("{}  Copy PR number   Ctrl+Shift+K", ic::COPY)).clicked() {
                            act = Some(Act::CopyNumber);
                        }
                        if ui.button(format!("{}  Copy checkout command", ic::TERMINAL)).clicked() {
                            act = Some(Act::CopyCheckout);
                        }
                    });
                    if open {
                        let tip = if project.is_none() {
                            crate::issues::NOT_PROJECT
                        } else if list.is_none() {
                            "Refresh the list first"
                        } else {
                            "Start a thread where an agent rebases it, fixes checks and reviews, then merges it (gh pr merge)"
                        };
                        match self.agent_button(ui, "Merge", project.is_some() && list.is_some(), tip) {
                            Some(Go::Now) => act = Some(Act::Merge(false)),
                            Some(Go::Ask) => act = Some(Act::Merge(true)),
                            None => {}
                        }
                        let tip = if project.is_some() { "Check out this branch in a terminal (gh pr checkout)" } else { "Add this repo as a project to check it out here" };
                        if w::btn(&format!("{}  Check out", ic::BRANCH)).sm().outline().enabled(project.is_some()).show(ui).on_hover_text(tip).on_disabled_hover_text(tip).clicked() {
                            act = Some(Act::Checkout);
                        }
                    }
                    if open && draft {
                        let label = if busy { "Marking ready…".to_string() } else { format!("{}  Ready for review", ic::PR_OPEN) };
                        if w::btn(&label).sm().primary().enabled(!busy).show(ui).on_hover_text("Mark this draft ready for review (gh pr ready)").clicked() {
                            act = Some(Act::Ready);
                        }
                    }
                });
            });
            ui.add_space(4.0);
            ui.add(egui::Label::new(RichText::new(&title).text_style(theme::ts("heading-20")).color(t.fg())).wrap());
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                let tex = self.prs.avatars.get(&author).and_then(|a| a.clone());
                paint_avatar(ui.painter(), r.center(), 9.0, tex.as_ref(), &author, &t);
                ui.label(RichText::new(&author).text_style(theme::ts("label-14")).color(t.fg()));
                if updated > 0 {
                    w::subtle(ui, format!("· updated {}", ago(updated)), "label-13");
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let r = ui
                        .add(egui::Label::new(RichText::new(&checkout).text_style(theme::ts("label-12-mono")).color(t.subtle())).sense(Sense::click()))
                        .on_hover_cursor(CursorIcon::PointingHand)
                        .on_hover_text("Copy");
                    if r.clicked() {
                        act = Some(Act::CopyCheckout);
                    }
                });
            });
            if let Some(f) = &full {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    let base_col = if f.conflicting { t.amber(900) } else { t.subtle() };
                    ui.label(RichText::new(&f.base).text_style(theme::ts("label-12-mono")).color(base_col));
                    if f.conflicting {
                        ui.label(RichText::new(ic::ALERT).size(13.0).color(t.amber(900))).on_hover_text("Has conflicts with the base branch");
                    }
                    ui.label(RichText::new(ic::ARROW_LEFT).size(12.0).color(t.gray(700)));
                    let r = ui
                        .add(egui::Label::new(RichText::new(&f.head).text_style(theme::ts("label-12-mono")).color(t.subtle())).sense(Sense::click()))
                        .on_hover_cursor(CursorIcon::PointingHand)
                        .on_hover_text("Copy branch name");
                    if r.clicked() {
                        ui.ctx().copy_text(f.head.clone());
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 5.0;
                        ui.label(RichText::new(format!("-{}", thousands(f.dels))).text_style(theme::ts("label-12-mono")).color(t.red(900)));
                        ui.label(RichText::new(format!("+{}", thousands(f.adds))).text_style(theme::ts("label-12-mono")).color(t.green(900)));
                        w::subtle(ui, format!("{} files", f.files), "label-13");
                        ui.label(RichText::new(ic::FILE).size(13.0).color(t.subtle()));
                    });
                });
            }
            if let Some(e) = &err {
                ui.add_space(6.0);
                ui.label(RichText::new(e).text_style(theme::ts("label-13-mono")).color(t.red(900)));
            }
        });
        w::separator(ui);

        // ---- tabs
        let mut new_tab = None;
        Frame::new().inner_margin(Margin::symmetric(16, 8)).show(ui, |ui| {
            ui.horizontal(|ui| {
                Frame::new().fill(t.gray(100)).corner_radius(CornerRadius::same(RADIUS_MD)).inner_margin(Margin::same(3)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 2.0;
                        for (v, label) in [(Tab::Summary, "Summary"), (Tab::Timeline, "Timeline"), (Tab::Code, "Code")] {
                            if seg(ui, label, tab == v).clicked() {
                                new_tab = Some(v);
                            }
                        }
                    });
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if loading {
                        ui.spinner();
                    } else if let Some(f) = &full {
                        let (icon, col, text) = checks_summary(&f.checks, &t);
                        w::subtle(ui, text, "label-13");
                        ui.label(RichText::new(icon).size(14.0).color(col));
                    }
                });
            });
        });
        w::separator(ui);
        if let Some(v) = new_tab {
            if let Some(d) = self.prs.details.get_mut(url) {
                d.tab = v;
            }
        }

        // ---- body
        match (tab, &full) {
            (_, None) => {
                ui.add_space(24.0);
                if loading {
                    ui.horizontal(|ui| {
                        ui.add_space(20.0);
                        ui.spinner();
                        w::subtle(ui, "Loading pull request…", "label-14");
                    });
                }
            }
            (Tab::Summary, Some(f)) => self.pr_summary(ui, url, f, &mut act),
            (Tab::Timeline, Some(f)) => self.pr_timeline(ui, url, f),
            (Tab::Code, Some(_)) => self.pr_code(ui, &ctx, url),
        }

        // ---- keys (the panel's own; the page handles Ctrl+W and friends)
        let (copy_link, copy_num) = ctx.input_mut(|i| (self.keys.take(i, "pr_copy_link"), self.keys.take(i, "pr_copy_number")));
        if copy_link {
            act = Some(Act::CopyLink);
        }
        if copy_num {
            act = Some(Act::CopyNumber);
        }

        if let Some(a) = act {
            match a {
                Act::OpenWeb => crate::git::open_url(url),
                Act::OpenPane => self.open_browser(Some(url.to_string())),
                Act::CopyLink => ctx.copy_text(url.to_string()),
                Act::CopyNumber => ctx.copy_text(number.to_string()),
                Act::CopyCheckout => ctx.copy_text(checkout.clone()),
                Act::Refresh => {
                    if let Some(d) = self.prs.details.get_mut(url) {
                        d.load(&ctx, url);
                        d.diff = None;
                    }
                }
                Act::Ready => {
                    if let Some(d) = self.prs.details.get_mut(url) {
                        d.ready(&ctx, url);
                    }
                }
                Act::Checkout => {
                    if let Some(r) = project.and_then(|id| self.repo(id)).cloned() {
                        let argv = vec!["gh".into(), "pr".into(), "checkout".into(), number.to_string()];
                        self.open_terminal(&ctx, &format!("checkout #{number}"), r.path.clone(), argv, vec![]);
                    }
                }
                Act::Merge(ask) => {
                    if let (Some(id), Some(p)) = (project, &list) {
                        if ask {
                            self.ask_instructions(id, Job::Merge(p.clone()));
                        } else {
                            self.merge_pr(&ctx, id, p, "");
                        }
                    }
                }
                Act::Review => {
                    if let Some(id) = project {
                        self.new_draft(Some(id));
                        self.drafts.insert(
                            crate::app::DRAFT,
                            format!("Review PR #{number} ({title}). Read it with `gh pr view {number}` and `gh pr diff {number}`, then list concrete problems by severity."),
                        );
                    }
                }
            }
        }
    }

    fn pr_summary(&mut self, ui: &mut Ui, url: &str, f: &Full, act: &mut Option<Act>) {
        let t = self.theme.t;
        let show_checks = self.prs.details.get(url).is_some_and(|d| d.show_checks);
        let mut toggle_checks = false;
        let open_desc_id = Id::NULL.with(("pr-desc-open", url));
        let open_comments_id = Id::NULL.with(("pr-comments-open", url));
        let mut desc_open = ui.data(|d| d.get_temp::<bool>(open_desc_id)).unwrap_or(true);
        let mut comments_open = ui.data(|d| d.get_temp::<bool>(open_comments_id)).unwrap_or(true);
        ScrollArea::vertical().id_salt(("pr-summary", url)).auto_shrink([false, false]).show(ui, |ui| {
            Frame::new().inner_margin(Margin { left: 20, right: 20, top: 12, bottom: 24 }).show(ui, |ui| {
                ui.set_width(ui.available_width());
                field(ui, ic::USERS, "Reviewers", |ui| {
                    if f.reviewers.is_empty() {
                        w::subtle(ui, "None", "label-14");
                    }
                    for (who, state) in &f.reviewers {
                        let (icon, col, what) = review_tone(state, &t);
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                        let tex = self.prs.avatars.get(who).and_then(|a| a.clone());
                        paint_avatar(ui.painter(), r.center(), 8.0, tex.as_ref(), who, &t);
                        ui.label(RichText::new(who).text_style(theme::ts("label-14")).color(t.fg()));
                        ui.label(RichText::new(icon).size(13.0).color(col)).on_hover_text(what);
                        ui.add_space(6.0);
                    }
                });
                field(ui, ic::TAG, "Labels", |ui| {
                    if f.labels.is_empty() {
                        w::subtle(ui, "None", "label-14");
                    }
                    for (name, rgb) in &f.labels {
                        chip(ui, name, Some(*rgb));
                    }
                });
                ui.add_space(10.0);
                if section_toggle(ui, "Description", desc_open) {
                    desc_open = !desc_open;
                }
                if desc_open {
                    ui.add_space(4.0);
                    if f.body.trim().is_empty() {
                        w::subtle(ui, "No description provided.", "copy-14");
                    } else {
                        ui.push_id(("pr-body", url), |ui| CommonMarkViewer::new().show(ui, &mut self.md, &f.body));
                    }
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        if w::btn(&format!("{}  Open in Web", ic::EXTERNAL)).sm().outline().show(ui).clicked() {
                            *act = Some(Act::OpenWeb);
                        }
                        if w::btn(&format!("{}  Open in Harbor's browser", ic::GLOBE)).sm().outline().show(ui).clicked() {
                            *act = Some(Act::OpenPane);
                        }
                    });
                }
                ui.add_space(14.0);
                let (icon, col, summary) = checks_summary(&f.checks, &t);
                ui.horizontal(|ui| {
                    if section_toggle(ui, "Checks", show_checks) {
                        toggle_checks = true;
                    }
                    if !f.checks.is_empty() {
                        ui.label(RichText::new(icon).size(13.0).color(col));
                        w::subtle(ui, summary, "label-13");
                    }
                });
                if show_checks {
                    ui.add_space(4.0);
                    if f.checks.is_empty() {
                        w::subtle(ui, "No checks reported.", "label-13");
                    }
                    for c in &f.checks {
                        let (icon, col) = check_tone(c.state, &t);
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(icon).size(14.0).color(col));
                            let r = ui.add(egui::Label::new(RichText::new(&c.name).text_style(theme::ts("label-14")).color(t.fg())).sense(Sense::click()));
                            if !c.url.is_empty() && r.on_hover_cursor(CursorIcon::PointingHand).on_hover_text("Open the run").clicked() {
                                crate::git::open_url(&c.url);
                            }
                        });
                    }
                }
                ui.add_space(14.0);
                if section_toggle(ui, &format!("Comments ({})", f.comments.len()), comments_open) {
                    comments_open = !comments_open;
                }
                if comments_open {
                    if f.comments.is_empty() {
                        ui.add_space(4.0);
                        w::subtle(ui, "No comments yet.", "label-13");
                    }
                    // Newest first, as T3 Code lists them.
                    for (i, c) in f.comments.iter().enumerate().rev() {
                        ui.add_space(8.0);
                        self.note(ui, Id::NULL.with(("pr-comment", url, i)), &c.author, c.at, "commented", &c.body);
                    }
                }
            });
        });
        ui.data_mut(|d| {
            d.insert_temp(open_desc_id, desc_open);
            d.insert_temp(open_comments_id, comments_open);
        });
        if toggle_checks {
            if let Some(d) = self.prs.details.get_mut(url) {
                d.show_checks = !d.show_checks;
            }
        }
    }

    /// A comment card: avatar, who, what and when, then the markdown body.
    pub fn note(&mut self, ui: &mut Ui, id: Id, who: &str, at: i64, what: &str, body: &str) {
        let t = self.theme.t;
        w::card(ui).inner_margin(Margin::symmetric(14, 10)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                let tex = self.prs.avatars.get(who).and_then(|a| a.clone());
                paint_avatar(ui.painter(), r.center(), 8.0, tex.as_ref(), who, &t);
                ui.label(RichText::new(who).text_style(theme::ts("strong-14")).color(t.fg()));
                w::subtle(ui, format!("{what} · {}", ago(at)), "label-13");
            });
            if !body.trim().is_empty() {
                ui.add_space(4.0);
                ui.push_id(id, |ui| CommonMarkViewer::new().show(ui, &mut self.md, body));
            }
        });
    }

    fn pr_timeline(&mut self, ui: &mut Ui, url: &str, f: &Full) {
        let t = self.theme.t;
        ScrollArea::vertical().id_salt(("pr-timeline", url)).auto_shrink([false, false]).show(ui, |ui| {
            Frame::new().inner_margin(Margin { left: 20, right: 20, top: 12, bottom: 24 }).show(ui, |ui| {
                ui.set_width(ui.available_width());
                for (i, (at, who, e)) in f.timeline.iter().enumerate() {
                    match e {
                        Event::Comment { body } => {
                            ui.add_space(6.0);
                            self.note(ui, Id::NULL.with(("pr-tl", url, i)), who, *at, "commented", body);
                            ui.add_space(6.0);
                        }
                        Event::Review { state, body } if !body.trim().is_empty() => {
                            let (_, _, what) = review_tone(state, &t);
                            ui.add_space(6.0);
                            self.note(ui, Id::NULL.with(("pr-tl", url, i)), who, *at, what, body);
                            ui.add_space(6.0);
                        }
                        _ => {
                            let (icon, col, text) = match e {
                                Event::Opened => (ic::PR_OPEN, t.green(900), format!("{who} opened this pull request")),
                                Event::Commit { sha, headline } => (ic::BRANCH, t.subtle(), format!("{sha}  {headline}")),
                                Event::Review { state, .. } => {
                                    let (icon, col, what) = review_tone(state, &t);
                                    (icon, col, format!("{who} {what}"))
                                }
                                Event::Comment { .. } => unreachable!(),
                            };
                            ui.horizontal(|ui| {
                                ui.set_min_height(26.0);
                                ui.label(RichText::new(icon).size(14.0).color(col));
                                let mono = matches!(e, Event::Commit { .. });
                                let style = if mono { "label-13-mono" } else { "label-14" };
                                ui.add(egui::Label::new(RichText::new(text).text_style(theme::ts(style)).color(t.fg())).truncate());
                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| w::subtle(ui, ago(*at), "label-13"));
                            });
                        }
                    }
                }
                if f.created == 0 && f.timeline.is_empty() {
                    w::subtle(ui, "Nothing yet.", "label-13");
                }
            });
        });
    }

    fn pr_code(&mut self, ui: &mut Ui, ctx: &egui::Context, url: &str) {
        let t = self.theme.t;
        let Some(d) = self.prs.details.get_mut(url) else { return };
        if d.diff.is_none() && !d.diff_loading {
            d.load_diff(ctx, url);
        }
        let lines = match &d.diff {
            None => {
                ui.add_space(24.0);
                ui.horizontal(|ui| {
                    ui.add_space(20.0);
                    ui.spinner();
                    w::subtle(ui, "Loading the diff…", "label-14");
                });
                return;
            }
            Some(Err(e)) => {
                Frame::new().inner_margin(Margin::same(20)).show(ui, |ui| {
                    ui.label(RichText::new(e).text_style(theme::ts("label-13-mono")).color(t.red(900)));
                });
                return;
            }
            Some(Ok(l)) => l.clone(),
        };
        if lines.is_empty() {
            Frame::new().inner_margin(Margin::same(20)).show(ui, |ui| w::subtle(ui, "No changes.", "label-14"));
            return;
        }
        let row_h = 18.0;
        let mono = FontId::new(12.5, egui::FontFamily::Monospace);
        ScrollArea::both().id_salt(("pr-code", url)).auto_shrink([false, false]).show_rows(ui, row_h, lines.len(), |ui, range| {
            for l in &lines[range] {
                let width = ui.available_width().max(600.0);
                let (rect, _) = ui.allocate_exact_size(Vec2::new(width, row_h), Sense::hover());
                let p = ui.painter();
                let x = rect.left() + 16.0;
                let y = rect.center().y;
                let text = |s: &str, c: Color32| {
                    p.text(pos2(x + 14.0, y), egui::Align2::LEFT_CENTER, s.replace('\t', "    "), mono.clone(), c);
                };
                match l {
                    Line::File { path, adds, dels } => {
                        p.rect_filled(rect, CornerRadius::ZERO, t.gray(100));
                        p.hline(rect.x_range(), rect.top(), Stroke::new(1.0, t.border()));
                        ic::glyph(p, pos2(x + 4.0, y), ic::FILE, 13.0, t.subtle());
                        let g = p.layout_no_wrap(path.clone(), FontId::new(13.0, theme::medium()), t.fg());
                        let gw = g.size().x;
                        p.galley(pos2(x + 16.0, y - g.size().y / 2.0), g, t.fg());
                        p.text(pos2(x + 26.0 + gw, y), egui::Align2::LEFT_CENTER, format!("+{adds}"), mono.clone(), t.green(900));
                        p.text(pos2(x + 26.0 + gw + 12.0 + 8.0 * (adds.to_string().len() as f32 + 1.0), y), egui::Align2::LEFT_CENTER, format!("-{dels}"), mono.clone(), t.red(900));
                    }
                    Line::Hunk(h) => {
                        p.rect_filled(rect, CornerRadius::ZERO, alpha(t.blue(700), 0.10));
                        text(h, t.blue(900));
                    }
                    Line::Add(s) => {
                        p.rect_filled(rect, CornerRadius::ZERO, alpha(t.green(700), 0.14));
                        p.text(pos2(x, y), egui::Align2::LEFT_CENTER, "+", mono.clone(), t.green(900));
                        text(s, t.fg());
                    }
                    Line::Del(s) => {
                        p.rect_filled(rect, CornerRadius::ZERO, alpha(t.red(700), 0.14));
                        p.text(pos2(x, y), egui::Align2::LEFT_CENTER, "-", mono.clone(), t.red(900));
                        text(s, t.fg());
                    }
                    Line::Ctx(s) => text(s, t.subtle()),
                }
            }
        });
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Act {
    OpenWeb,
    OpenPane,
    CopyLink,
    CopyNumber,
    CopyCheckout,
    Refresh,
    Ready,
    Checkout,
    Review,
    /// True: ask for instructions first.
    Merge(bool),
}

/// A segmented-control button.
pub fn seg(ui: &mut Ui, label: &str, on: bool) -> egui::Response {
    let t = w::tokens(ui);
    let g = ui.painter().layout_no_wrap(label.into(), FontId::new(14.0, theme::medium()), if on { t.fg() } else { t.subtle() });
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(g.size().x + 24.0, 28.0), Sense::click());
    if on {
        ui.painter().rect(rect, CornerRadius::same(RADIUS_MD - 1), t.bg100, Stroke::new(1.0, t.border()), StrokeKind::Inside);
    } else if resp.hovered() {
        ui.painter().rect_filled(rect, CornerRadius::same(RADIUS_MD - 1), alpha(t.accent(), 0.6));
    }
    ui.painter().galley(rect.center() - g.size() / 2.0, g, t.fg());
    resp.on_hover_cursor(CursorIcon::PointingHand)
}

/// owner/name from a PR URL.
pub fn repo_of(url: &str) -> String {
    let rest = url.strip_prefix("https://github.com/").unwrap_or(url);
    rest.split("/pull/").next().unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_in_markdown() {
        let s = "<!-- BEGIN -->\nText <b>bold</b> and `<div>` kept\n<!-- a\nb -->\n```\n<div>x</div>\n```\n<div><a href=\"u\"><img src=\"x\"></a></div>\n";
        assert_eq!(clean_md(s), "\nText bold and `<div>` kept\n\n```\n<div>x</div>\n```\n\n");
        assert_eq!(clean_md("a < b > c, Vec<T>"), "a < b > c, Vec<T>");
    }

    #[test]
    fn diff_lines() {
        let d = "diff --git a/src/x.rs b/src/x.rs\nindex 1..2 100644\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -1,2 +1,2 @@\n fn a() {}\n-old\n+new\n+more\n\\ No newline at end of file\n";
        let l = parse_diff(d);
        assert_eq!(l[0], Line::File { path: "src/x.rs".into(), adds: 2, dels: 1 });
        assert_eq!(l[1], Line::Hunk("@@ -1,2 +1,2 @@".into()));
        assert_eq!(l[2], Line::Ctx("fn a() {}".into()));
        assert_eq!(l[3], Line::Del("old".into()));
        assert_eq!(l.len(), 6);
    }

    #[test]
    fn view_json() {
        let v = serde_json::json!({
            "number": 7, "title": "T", "url": "https://github.com/o/r/pull/7", "state": "OPEN", "isDraft": true,
            "author": {"login": "a"}, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-02T00:00:00Z",
            "baseRefName": "main", "headRefName": "feat", "additions": 3, "deletions": 1, "changedFiles": 2,
            "labels": [{"name": "bug", "color": "ff0000"}],
            "reviewRequests": [{"login": "b"}], "latestReviews": [{"author": {"login": "c"}, "state": "APPROVED"}],
            "reviews": [{"author": {"login": "c"}, "state": "APPROVED", "body": "", "submittedAt": "2026-01-03T00:00:00Z"}],
            "comments": [{"author": {"login": "d"}, "body": "hi", "createdAt": "2026-01-02T12:00:00Z"}],
            "statusCheckRollup": [{"name": "ci", "status": "COMPLETED", "conclusion": "SUCCESS"}, {"context": "lint", "state": "PENDING"}],
            "commits": [{"oid": "abcdef0123", "messageHeadline": "first", "committedDate": "2026-01-01T06:00:00Z", "authors": [{"login": "a"}]}],
            "mergeable": "CONFLICTING"
        });
        let f = parse(&v);
        assert_eq!(f.reviewers, vec![("c".to_string(), "APPROVED".to_string()), ("b".to_string(), "PENDING".to_string())]);
        assert_eq!(f.labels[0], ("bug".to_string(), [255, 0, 0]));
        assert!(f.checks[0].state == CheckState::Pass && f.checks[1].state == CheckState::Pending);
        assert!(f.conflicting && f.draft);
        let kinds: Vec<&str> = f.timeline.iter().map(|e| match e.2 { Event::Opened => "o", Event::Commit { .. } => "c", Event::Comment { .. } => "m", Event::Review { .. } => "r" }).collect();
        assert_eq!(kinds, ["o", "c", "m", "r"]);
        assert_eq!(repo_of(&f.url), "o/r");
    }
}
