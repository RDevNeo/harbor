//! One issue in the Issues page's side panel, laid out like a pull request's
//! (prdetail.rs): repo and number (a link), title, author and state, then
//! Assignees, Labels and Milestone, the description and the comments.
//! Actions: Close / Reopen, Fix with <provider> (an agent thread in the project), and a
//! ⋯ menu (refresh, open, copy link / number).

use crate::widgets::Tip as _;
use crate::app::App;
use crate::autowork::{Go, Job};
use crate::icons as ic;
use crate::issues::{Issue, IssueState, state_icon, state_of};
use crate::prdetail::{Note, chip, clean_md, ctx_repaint, field, gh, section_toggle};
use crate::prs::{ago, hex_rgb, iso_secs, paint_avatar};
use crate::theme;
use crate::widgets as w;
use eframe::egui::{self, CursorIcon, Frame, Id, Margin, RichText, ScrollArea, Sense, Ui, Vec2};
use egui_commonmark::CommonMarkViewer;
use std::sync::mpsc::{Receiver, Sender, channel};

const FIELDS: &str = "number,title,body,url,state,stateReason,author,createdAt,updatedAt,labels,assignees,milestone,comments";

#[derive(Clone)]
pub struct Full {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: IssueState,
    pub author: String,
    pub created: i64,
    pub updated: i64,
    pub labels: Vec<(String, [u8; 3])>,
    pub assignees: Vec<String>,
    pub milestone: Option<String>,
    pub body: String,
    pub comments: Vec<Note>,
}

enum Msg {
    Full(Result<Full, String>),
    /// Close / reopen finished: refresh.
    Done(Result<(), String>),
}

/// One open tab's state.
pub struct Detail {
    pub full: Option<Result<std::sync::Arc<Full>, String>>,
    pub loading: bool,
    pub busy: bool,
    pub error: Option<String>,
    /// The PC of the mesh whose GitHub account loads and changes it (None: this PC's).
    pub via: Option<crate::mesh::Dest>,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
}

impl Default for Detail {
    fn default() -> Self {
        let (tx, rx) = channel();
        Detail { full: None, loading: false, busy: false, error: None, via: None, tx, rx }
    }
}

fn login(v: &serde_json::Value) -> String {
    v["login"].as_str().or(v["name"].as_str()).unwrap_or("ghost").to_string()
}

pub fn fetch(url: &str) -> Result<Full, String> {
    fetch_raw(url).map(|v| parse(&v))
}

/// `gh issue view` as JSON (what another PC asks for: `GET /mesh/v1/issues/view`).
pub fn fetch_raw(url: &str) -> Result<serde_json::Value, String> {
    let out = gh(&["issue", "view", url, "--json", FIELDS])?;
    serde_json::from_slice(&out).map_err(|e| e.to_string())
}

/// The issue as another PC of the mesh sees it, with its own `gh` login.
pub fn fetch_on(dest: &crate::mesh::Dest, url: &str) -> Result<Full, String> {
    let path = format!("/mesh/v1/issues/view?url={}", crate::api::url_encode(url));
    match crate::mesh::http(dest, "GET", &path, None, crate::prs::GH_TIMEOUT)? {
        (200, v) => Ok(parse(&v)),
        (s, v) => Err(v["error"].as_str().map_or_else(|| format!("the other PC answered {s}"), String::from)),
    }
}

/// Close or reopen the issue on another PC of the mesh.
pub fn set_open_on(dest: &crate::mesh::Dest, url: &str, open: bool) -> Result<(), String> {
    let path = format!("/mesh/v1/issues/{}?url={}", if open { "reopen" } else { "close" }, crate::api::url_encode(url));
    match crate::mesh::http(dest, "POST", &path, Some(("application/json", b"{}")), crate::prs::GH_TIMEOUT)? {
        (200, _) => Ok(()),
        (s, v) => Err(v["error"].as_str().map_or_else(|| format!("the other PC answered {s}"), String::from)),
    }
}

fn parse(v: &serde_json::Value) -> Full {
    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let arr = |k: &str| v[k].as_array().cloned().unwrap_or_default();
    let ts = |x: &serde_json::Value, k: &str| x[k].as_str().and_then(iso_secs).unwrap_or(0);
    Full {
        number: v["number"].as_u64().unwrap_or(0),
        title: s("title"),
        url: s("url"),
        state: state_of(&s("state"), &s("stateReason")),
        author: login(&v["author"]),
        created: ts(v, "createdAt"),
        updated: ts(v, "updatedAt"),
        labels: arr("labels").iter().filter_map(|l| Some((l["name"].as_str()?.to_string(), hex_rgb(l["color"].as_str().unwrap_or(""))))).collect(),
        assignees: arr("assignees").iter().map(login).collect(),
        milestone: v["milestone"]["title"].as_str().filter(|m| !m.is_empty()).map(String::from),
        body: clean_md(&s("body")),
        comments: arr("comments").iter().map(|c| Note { author: login(&c["author"]), at: ts(c, "createdAt"), body: clean_md(c["body"].as_str().unwrap_or("")) }).collect(),
    }
}

impl Detail {
    pub fn load(&mut self, ctx: &egui::Context, url: &str) {
        self.loading = true;
        let (tx, url, wake, via) = (self.tx.clone(), url.to_string(), ctx_repaint(ctx), self.via.clone());
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Full(via.map_or_else(|| fetch(&url), |d| fetch_on(&d, &url))));
            wake();
        });
    }

    /// `gh issue close` / `gh issue reopen`.
    fn set_open(&mut self, ctx: &egui::Context, url: &str, open: bool) {
        self.busy = true;
        let (tx, url, wake, via) = (self.tx.clone(), url.to_string(), ctx_repaint(ctx), self.via.clone());
        std::thread::spawn(move || {
            let r = match via {
                Some(d) => set_open_on(&d, &url, open),
                None => gh(&["issue", if open { "reopen" } else { "close" }, &url]).map(|_| ()),
            };
            let _ = tx.send(Msg::Done(r));
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
                        self.full = Some(r.map(std::sync::Arc::new));
                    }
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

#[derive(Clone, Copy, PartialEq)]
enum Act {
    OpenWeb,
    OpenPane,
    CopyLink,
    CopyNumber,
    Refresh,
    Close,
    Reopen,
    /// True: ask for instructions first.
    Work(bool),
}

/// owner/name from an issue URL.
pub fn repo_of(url: &str) -> String {
    let rest = url.strip_prefix("https://github.com/").unwrap_or(url);
    rest.split("/issues/").next().unwrap_or("").to_string()
}

impl App {
    /// The panel body for the issue at `url` (its list row shows while the rest loads).
    pub fn issue_detail(&mut self, ui: &mut Ui, url: &str) {
        let t = self.theme.t;
        let ctx = ui.ctx().clone();
        // Loaded and changed with the GitHub account of a PC of the mesh that sees it, when
        // this PC's doesn't.
        let via = self.listed_issue(url).and_then(|i| self.issue_peer(&i, false)).map(|p| p.dest());
        let d = self.issues.details.entry(url.to_string()).or_default();
        d.via = via;
        if d.full.is_none() && !d.loading {
            d.load(&ctx, url);
        }
        if d.poll(&ctx, url) {
            self.load_issues();
        }
        let list = self.issues.data.as_ref().and_then(|d| d.as_ref().ok()).and_then(|f| f.items.iter().find(|i| i.url == url).cloned());
        let Some(d) = self.issues.details.get(url) else { return };
        let full = d.full.as_ref().and_then(|f| f.as_ref().ok()).cloned();
        let err = match &d.full {
            Some(Err(e)) => Some(e.clone()),
            _ => d.error.clone(),
        };
        let (loading, busy) = (d.loading, d.busy);
        if let Some(f) = &full {
            // Commenters' avatars too.
            let people: Vec<String> = f.comments.iter().map(|c| c.author.clone()).chain(f.assignees.iter().cloned()).collect();
            let missing: Vec<(String, String)> = people.into_iter().filter(|p| !self.prs.avatars.contains_key(p)).map(|p| (p.clone(), format!("https://github.com/{p}.png?size=40"))).collect();
            self.fetch_avatars(missing.into_iter());
        }

        let number = full.as_ref().map(|f| f.number).or(list.as_ref().map(|i| i.number)).unwrap_or(0);
        let title = full.as_ref().map(|f| f.title.clone()).or(list.as_ref().map(|i| i.title.clone())).unwrap_or_default();
        let repo = list.as_ref().map(|i| i.repo.clone()).unwrap_or_else(|| repo_of(url));
        let author = full.as_ref().map(|f| f.author.clone()).or(list.as_ref().map(|i| i.author.clone())).unwrap_or_default();
        let updated = full.as_ref().map(|f| f.updated).or(list.as_ref().map(|i| i.updated)).unwrap_or(0);
        let state = full.as_ref().map(|f| f.state).or(list.as_ref().map(|i| i.state)).unwrap_or(IssueState::Open);
        let project = self.pr_projects().into_iter().find(|p| p.2.eq_ignore_ascii_case(&repo)).map(|p| p.0);
        // No project here, but another PC of the mesh has it: the agent runs there.
        let elsewhere = if project.is_none() { list.as_ref().and_then(|i| self.issue_peer(i, true)).map(|p| p.name) } else { None };

        let mut act: Option<Act> = None;
        // ---- header
        Frame::new().inner_margin(Margin { left: 20, right: 16, top: 6, bottom: 10 }).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let r = ui
                    .add(egui::Label::new(RichText::new(format!("{} #{number}  {}", repo.to_lowercase(), ic::EXTERNAL)).text_style(theme::ts("label-14")).color(t.subtle())).sense(Sense::click()))
                    .on_hover_cursor(CursorIcon::PointingHand)
                    .tip("Open on GitHub");
                if r.clicked() {
                    act = Some(Act::OpenWeb);
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    let more = w::btn("⋯").muted().icon_xs().show(ui).tip("More actions");
                    egui::Popup::menu(&more).show(|ui| {
                        ui.set_min_width(200.0);
                        if ui.button(format!("{}  Refresh", ic::REFRESH)).clicked() {
                            act = Some(Act::Refresh);
                        }
                        ui.separator();
                        if ui.button(format!("{}  Open in the side browser", ic::GLOBE)).clicked() {
                            act = Some(Act::OpenPane);
                        }
                        if ui.button(format!("{}  Open on GitHub", ic::EXTERNAL)).clicked() {
                            act = Some(Act::OpenWeb);
                        }
                        if ui.button(format!("{}  Copy link", ic::LINK)).clicked() {
                            act = Some(Act::CopyLink);
                        }
                        if ui.button(format!("{}  Copy issue number", ic::COPY)).clicked() {
                            act = Some(Act::CopyNumber);
                        }
                    });
                    let (label, a, tip) = if state == IssueState::Open {
                        (format!("{}  Close", ic::CIRCLE_CHECK), Act::Close, "Close as completed (gh issue close)")
                    } else {
                        (format!("{}  Reopen", ic::CIRCLE_DOT), Act::Reopen, "Reopen the issue (gh issue reopen)")
                    };
                    let label = if busy { "Saving…".to_string() } else { label };
                    if w::btn(&label).xs().outline().enabled(!busy).show(ui).tip(tip).clicked() {
                        act = Some(a);
                    }
                    if state == IssueState::Open {
                        let tip = match (&project, &elsewhere) {
                            (Some(_), _) => "Start a thread where an agent fixes it on a branch and opens a PR".to_string(),
                            (None, Some(pc)) => format!("Start a thread on {pc}, which has this project, where an agent fixes it and opens a PR"),
                            (None, None) => crate::issues::NOT_PROJECT.to_string(),
                        };
                        match self.agent_button(ui, "Fix", project.is_some() || elsewhere.is_some(), &tip) {
                            Some(Go::Now) => act = Some(Act::Work(false)),
                            Some(Go::Ask) => act = Some(Act::Work(true)),
                            None => {}
                        }
                    }
                });
            });
            ui.add_space(4.0);
            ui.add(egui::Label::new(RichText::new(&title).text_style(theme::ts("heading-20")).color(t.fg())).wrap());
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                let (icon, col, what) = state_icon(state, &t);
                ui.label(RichText::new(icon).size(15.0).color(col));
                ui.label(RichText::new(what).text_style(theme::ts("label-14")).color(col));
                ui.add_space(6.0);
                let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                let tex = self.prs.avatars.get(&author).and_then(|a| a.clone());
                paint_avatar(ui.painter(), r.center(), 9.0, tex.as_ref(), &author, &t);
                ui.label(RichText::new(&author).text_style(theme::ts("label-14")).color(t.fg()));
                if let Some(f) = full.as_ref().filter(|f| f.created > 0) {
                    w::subtle(ui, format!("opened {}", ago(f.created)), "label-13");
                }
                if updated > 0 {
                    w::subtle(ui, format!("· updated {}", ago(updated)), "label-13");
                }
            });
            if let Some(e) = &err {
                ui.add_space(6.0);
                ui.label(RichText::new(e).text_style(theme::ts("label-13-mono")).color(t.red(900)));
            }
        });
        w::separator(ui);

        // ---- body
        match &full {
            None => {
                ui.add_space(24.0);
                if loading {
                    ui.horizontal(|ui| {
                        ui.add_space(20.0);
                        w::busy(ui);
                        w::subtle(ui, "Loading issue…", "label-14");
                    });
                }
            }
            Some(f) => self.issue_summary(ui, url, f, &mut act),
        }

        if let Some(a) = act {
            match a {
                Act::OpenWeb => crate::git::open_url(url),
                Act::OpenPane => self.open_browser(Some(url.to_string())),
                Act::CopyLink => ctx.copy_text(full.as_ref().map_or(url, |f| f.url.as_str()).to_string()),
                Act::CopyNumber => ctx.copy_text(number.to_string()),
                Act::Refresh => {
                    if let Some(d) = self.issues.details.get_mut(url) {
                        d.load(&ctx, url);
                    }
                }
                Act::Close | Act::Reopen => {
                    if let Some(d) = self.issues.details.get_mut(url) {
                        d.set_open(&ctx, url, a == Act::Reopen);
                    }
                }
                Act::Work(ask) => {
                    let item = list.clone().or_else(|| {
                        full.as_ref().map(|f| Issue {
                            number: f.number,
                            title: f.title.clone(),
                            url: url.to_string(),
                            repo: repo.clone(),
                            state: f.state,
                            created: f.created,
                            updated: f.updated,
                            comments: f.comments.len() as u64,
                            author: f.author.clone(),
                            avatar: String::new(),
                            labels: f.labels.clone(),
                            assignees: f.assignees.clone(),
                            milestone: f.milestone.clone(),
                            linked_pr: false,
                            // Started by the user here, not unattended.
                            author_trusted: false,
                            ..Default::default()
                        })
                    });
                    if let (None, Some(_), Some(i)) = (project, &elsewhere, &item) {
                        if ask {
                            self.ask_instructions(0, Job::Fix(i.clone()));
                        } else {
                            self.fix_issue_on_peer(i, "");
                        }
                    } else if let (Some(id), Some(i)) = (project, item) {
                        if ask {
                            self.ask_instructions(id, Job::Fix(i));
                        } else {
                            self.fix_issue(&ctx, id, &i, "");
                        }
                    }
                }
            }
        }
    }

    fn issue_summary(&mut self, ui: &mut Ui, url: &str, f: &Full, act: &mut Option<Act>) {
        let t = self.theme.t;
        let open_desc_id = Id::NULL.with(("issue-desc-open", url));
        let open_comments_id = Id::NULL.with(("issue-comments-open", url));
        let mut desc_open = ui.data(|d| d.get_temp::<bool>(open_desc_id)).unwrap_or(true);
        let mut comments_open = ui.data(|d| d.get_temp::<bool>(open_comments_id)).unwrap_or(true);
        ScrollArea::vertical().id_salt(("issue-summary", url)).auto_shrink([false, false]).show(ui, |ui| {
            Frame::new().inner_margin(Margin { left: 20, right: 20, top: 12, bottom: 24 }).show(ui, |ui| {
                ui.set_width(ui.available_width());
                field(ui, ic::USER_CHECK, "Assignees", |ui| {
                    if f.assignees.is_empty() {
                        w::subtle(ui, "None", "label-14");
                    }
                    for who in &f.assignees {
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                        let tex = self.prs.avatars.get(who).and_then(|a| a.clone());
                        paint_avatar(ui.painter(), r.center(), 8.0, tex.as_ref(), who, &t);
                        ui.label(RichText::new(who).text_style(theme::ts("label-14")).color(t.fg()));
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
                field(ui, ic::MILESTONE, "Milestone", |ui| match &f.milestone {
                    Some(m) => chip(ui, m, None),
                    None => {
                        w::subtle(ui, "None", "label-14");
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
                        ui.push_id(("issue-body", url), |ui| CommonMarkViewer::new().show(ui, &mut self.md, &f.body));
                    }
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        if w::btn(&format!("{}  Open in Web", ic::EXTERNAL)).xs().outline().show(ui).clicked() {
                            *act = Some(Act::OpenWeb);
                        }
                        if w::btn(&format!("{}  Open in Harbor's browser", ic::GLOBE)).xs().outline().show(ui).clicked() {
                            *act = Some(Act::OpenPane);
                        }
                    });
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
                    // Oldest first: an issue reads as a conversation.
                    for (i, c) in f.comments.iter().enumerate() {
                        ui.add_space(8.0);
                        self.note(ui, Id::NULL.with(("issue-comment", url, i)), &c.author, c.at, "commented", &c.body);
                    }
                }
            });
        });
        ui.data_mut(|d| {
            d.insert_temp(open_desc_id, desc_open);
            d.insert_temp(open_comments_id, comments_open);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_json() {
        let v = serde_json::json!({
            "number": 3, "title": "T", "body": "b", "url": "https://github.com/o/r/issues/3", "state": "CLOSED", "stateReason": "COMPLETED",
            "author": {"login": "a"}, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-02T00:00:00Z",
            "labels": [{"name": "bug", "color": "00ff00"}], "assignees": [{"login": "b"}], "milestone": {"title": "v1"},
            "comments": [{"author": {"login": "c"}, "body": "hi", "createdAt": "2026-01-01T12:00:00Z"}]
        });
        let f = parse(&v);
        assert_eq!(f.state, IssueState::Done);
        assert_eq!(f.labels[0], ("bug".to_string(), [0, 255, 0]));
        assert_eq!((f.assignees.clone(), f.milestone.clone()), (vec!["b".to_string()], Some("v1".to_string())));
        assert_eq!(f.comments[0].author, "c");
        assert_eq!(repo_of(&f.url), "o/r");
        assert_eq!(parse(&serde_json::json!({"milestone": null})).milestone, None);
    }
}
