//! "Add project" palette (T3 style): pick a source (new repository, local folder,
//! Git URL, GitHub repository), then search inside it. Arrows move, Enter picks,
//! Backspace on an empty search goes back, Esc closes.

use crate::app::{App, Bg, View, tilde};
use crate::icons as ic;
use crate::store;
use crate::widgets as w;
use eframe::egui::{self, CornerRadius, FontId, Frame, Id, Key, Margin, Rect, ScrollArea, Sense, Stroke, Ui, Vec2, pos2};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq)]
pub enum Step {
    Sources,
    New,
    Local,
    Url,
    GitHub,
}

pub struct AddProject {
    step: Step,
    query: String,
    sel: usize,
    found: Vec<PathBuf>,
    /// "owner/repo" (lowercase) of each discovered repository's GitHub origin → its folder.
    clones: HashMap<String, PathBuf>,
    /// GitHub repositories (owner/name, description) from `gh repo list`.
    gh: Option<Result<Vec<(String, String)>, String>>,
    gh_loading: bool,
    /// Clone in progress ("Cloning owner/repo…").
    pub busy: Option<String>,
    pub error: Option<String>,
    focus: bool,
}

/// Where new and cloned repositories go.
fn projects_dir() -> PathBuf {
    store::home().join("Projects")
}

fn expand(p: &str) -> PathBuf {
    let p = p.trim();
    p.strip_prefix("~/").map(|r| store::home().join(r)).unwrap_or_else(|| if p == "~" { store::home() } else { PathBuf::from(p) })
}

/// "https://github.com/a/b.git" / "git@host:a/b" → "b".
fn repo_name(url: &str) -> String {
    let last = url.trim().trim_end_matches('/').rsplit(['/', ':']).next().unwrap_or("");
    last.trim_end_matches(".git").to_string()
}

/// One row of the current step.
enum Act {
    Step(Step),
    Add(PathBuf),
    Browse,
    Create(String),
    Clone { url: String, name: String },
}

struct Row {
    icon: Icon,
    title: String,
    detail: String,
    act: Act,
}

enum Icon {
    Glyph(&'static str),
    GitHub,
}

impl App {
    pub fn open_add_project(&mut self) {
        self.popup = None;
        let found = crate::git::discover();
        let clones = found.iter().filter_map(|p| github_slug(p).map(|s| (s, p.clone()))).collect();
        self.add_project = Some(AddProject {
            step: Step::Sources,
            query: String::new(),
            sel: 0,
            clones,
            found,
            gh: None,
            gh_loading: false,
            busy: None,
            error: None,
            focus: true,
        });
    }

    /// Adds a folder as a project and selects it.
    pub fn add_project_path(&mut self, p: &Path) -> Result<(), String> {
        if !p.is_dir() {
            return Err(format!("Not a folder: {}", tilde(p)));
        }
        let id = self.store.add_repo(p).map_err(|e| e.to_string())?;
        self.repos = self.store.repos();
        self.collapsed.remove(&id);
        self.refresh_git(id);
        if self.view == View::Draft {
            self.draft.repo = Some(id);
        }
        Ok(())
    }

    pub fn add_project_bg(&mut self, m: Bg) {
        let Some(ap) = self.add_project.as_mut() else { return };
        match m {
            Bg::GhRepos(r) => {
                ap.gh = Some(r);
                ap.gh_loading = false;
            }
            Bg::Cloned(Ok(path)) => {
                ap.busy = None;
                match self.add_project_path(&path) {
                    Ok(()) => self.add_project = None,
                    Err(e) => self.add_project.as_mut().unwrap().error = Some(e),
                }
            }
            Bg::Cloned(Err(e)) => {
                ap.busy = None;
                ap.error = Some(e);
            }
            _ => {}
        }
    }

    fn rows(&self, ap: &AddProject) -> Vec<Row> {
        let q = ap.query.trim();
        let ql = q.to_lowercase();
        let known: HashSet<PathBuf> = self.repos.iter().map(|r| r.path.clone()).collect();
        let g = |i| Icon::Glyph(i);
        let mut v = vec![];
        match ap.step {
            Step::Sources => {
                for (icon, title, detail, step) in [
                    (g(ic::FOLDER), "New project", "Start a new Git repository from a name", Step::New),
                    (g(ic::FOLDER_PLUS), "Local folder", "Pick a folder on disk", Step::Local),
                    (g(ic::LINK), "Git URL", "Clone from a remote URL", Step::Url),
                    (Icon::GitHub, "GitHub repository", "Clone GitHub owner/repo", Step::GitHub),
                ] {
                    if ql.is_empty() || title.to_lowercase().contains(&ql) {
                        v.push(Row { icon, title: title.into(), detail: detail.into(), act: Act::Step(step) });
                    }
                }
            }
            Step::New => {
                if !q.is_empty() {
                    let dir = projects_dir().join(q);
                    v.push(Row { icon: g(ic::FOLDER), title: format!("Create “{q}”"), detail: format!("git init in {}", tilde(&dir)), act: Act::Create(q.into()) });
                }
            }
            Step::Local => {
                let typed = expand(q);
                if (q.starts_with('/') || q.starts_with('~')) && typed.is_dir() {
                    v.push(Row { icon: g(ic::FOLDER), title: format!("Use {}", tilde(&typed)), detail: "Add this folder".into(), act: Act::Add(typed) });
                }
                v.push(Row { icon: g(ic::FOLDER_PLUS), title: "Browse…".into(), detail: "Choose a folder with the file picker".into(), act: Act::Browse });
                for p in ap.found.iter().filter(|p| !known.contains(*p) && p.to_string_lossy().to_lowercase().contains(&ql)) {
                    let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                    v.push(Row { icon: g(ic::FOLDER), title: name, detail: tilde(p), act: Act::Add(p.clone()) });
                }
            }
            Step::Url => {
                if !q.is_empty() {
                    let name = repo_name(q);
                    let dir = projects_dir().join(&name);
                    v.push(Row { icon: g(ic::LINK), title: format!("Clone {q}"), detail: format!("into {}", tilde(&dir)), act: Act::Clone { url: q.into(), name } });
                }
            }
            Step::GitHub => {
                if q.contains('/') && !q.contains(' ') {
                    v.push(self.gh_row(ap, q, "", &known));
                }
                if let Some(Ok(list)) = &ap.gh {
                    for (full, desc) in list.iter().filter(|(f, d)| f.to_lowercase().contains(&ql) || d.to_lowercase().contains(&ql)) {
                        if full != q {
                            v.push(self.gh_row(ap, full, desc, &known));
                        }
                    }
                }
            }
        }
        v
    }

    /// A GitHub repository row: adds your existing clone when there is one, else clones.
    fn gh_row(&self, ap: &AddProject, full: &str, desc: &str, known: &HashSet<PathBuf>) -> Row {
        let name = repo_name(full);
        let target = projects_dir().join(&name);
        let full_l = full.to_lowercase();
        let owner = full_l.split('/').next().unwrap_or("");
        // Exact origin match, else a folder of the same name from the same owner
        // (repositories renamed on GitHub keep their old origin URL locally).
        let local = ap
            .clones
            .get(&full_l)
            .or_else(|| ap.clones.iter().find(|(slug, p)| slug.split('/').next() == Some(owner) && p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(&name))).map(|(_, p)| p))
            .cloned()
            .or_else(|| target.join(".git").exists().then(|| target.clone()));
        match local {
            Some(p) if known.contains(&p) => Row { icon: Icon::GitHub, title: full.into(), detail: format!("Already in Harbor: {}", tilde(&p)), act: Act::Add(p) },
            Some(p) => Row { icon: Icon::GitHub, title: full.into(), detail: format!("Add your clone at {}", tilde(&p)), act: Act::Add(p) },
            None => {
                let detail = if desc.is_empty() { format!("Clone into {}", tilde(&target)) } else { desc.to_string() };
                Row { icon: Icon::GitHub, title: full.into(), detail, act: Act::Clone { url: full.into(), name } }
            }
        }
    }

    fn run(&mut self, act: Act, ctx: &egui::Context) {
        let tx = self.bg_tx.clone();
        // Background results wake the UI through this.
        let ctx = ctx.clone();
        let tx = Waker { tx, ctx };
        let Some(ap) = self.add_project.as_mut() else { return };
        ap.error = None;
        match act {
            Act::Step(s) => {
                ap.step = s;
                ap.query.clear();
                ap.sel = 0;
                ap.focus = true;
                if s == Step::GitHub && ap.gh.is_none() && !ap.gh_loading {
                    ap.gh_loading = true;
                    std::thread::spawn(move || tx.send(Bg::GhRepos(gh_repos())));
                }
            }
            Act::Add(p) => match self.add_project_path(&p) {
                Ok(()) => self.add_project = None,
                Err(e) => self.add_project.as_mut().unwrap().error = Some(e),
            },
            Act::Browse => {
                std::thread::spawn(move || {
                    let out = std::process::Command::new("zenity").args(["--file-selection", "--directory", "--title=Add project"]).output();
                    if let Ok(o) = out {
                        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                        if !p.is_empty() {
                            tx.send(Bg::Cloned(Ok(PathBuf::from(p))));
                        }
                    }
                });
            }
            Act::Create(name) => {
                let dir = projects_dir().join(&name);
                let r = if dir.exists() {
                    Err(format!("{} already exists", tilde(&dir)))
                } else {
                    std::fs::create_dir_all(&dir)
                        .map_err(|e| e.to_string())
                        .and_then(|_| std::process::Command::new("git").arg("init").arg("-q").arg(&dir).status().map_err(|e| e.to_string()))
                        .and_then(|s| if s.success() { Ok(()) } else { Err("git init failed".into()) })
                };
                match r.and_then(|_| self.add_project_path(&dir)) {
                    Ok(()) => self.add_project = None,
                    Err(e) => self.add_project.as_mut().unwrap().error = Some(e),
                }
            }
            Act::Clone { url, name } => {
                let dir = projects_dir().join(&name);
                if dir.exists() {
                    ap.error = Some(format!("{} already exists", tilde(&dir)));
                    return;
                }
                ap.busy = Some(format!("Cloning {url}…"));
                let github = ap.step == Step::GitHub;
                std::thread::spawn(move || {
                    let _ = std::fs::create_dir_all(projects_dir());
                    let out = if github {
                        std::process::Command::new("gh").args(["repo", "clone", &url]).arg(&dir).args(["--", "-q"]).output()
                    } else {
                        std::process::Command::new("git").args(["clone", "-q", &url]).arg(&dir).output()
                    };
                    let r = match out {
                        Ok(o) if o.status.success() => Ok(dir),
                        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().lines().last().unwrap_or("Clone failed").to_string()),
                        Err(e) => Err(e.to_string()),
                    };
                    tx.send(Bg::Cloned(r));
                });
            }
        }
    }

    pub fn add_project_ui(&mut self, ctx: &egui::Context) {
        let Some(mut ap) = self.add_project.take() else { return };
        let t = self.theme.t;
        let rows = self.rows(&ap);
        let mut act: Option<Act> = None;
        let mut close = false;
        let search_id = Id::NULL.with("add-project-search");

        // Keys: handled before the search field so Enter/arrows don't reach it.
        let (up, down, enter, back) = ctx.input_mut(|i| {
            (
                i.consume_key(egui::Modifiers::NONE, Key::ArrowUp),
                i.consume_key(egui::Modifiers::NONE, Key::ArrowDown),
                i.consume_key(egui::Modifiers::NONE, Key::Enter),
                ap.query.is_empty() && ap.step != Step::Sources && i.consume_key(egui::Modifiers::NONE, Key::Backspace),
            )
        });
        if !rows.is_empty() {
            if up {
                ap.sel = (ap.sel + rows.len() - 1) % rows.len();
            }
            if down {
                ap.sel = (ap.sel + 1) % rows.len();
            }
        }
        ap.sel = ap.sel.min(rows.len().saturating_sub(1));
        let mut rows = rows;
        if enter && ap.busy.is_none() && ap.sel < rows.len() {
            act = Some(rows.swap_remove(ap.sel).act);
            rows.clear();
        }
        if back {
            ap.step = Step::Sources;
            ap.sel = 0;
        }

        let modal = egui::Modal::new(Id::NULL.with("add-project"))
            .frame(
                Frame::new()
                    .fill(t.bg100)
                    .stroke(Stroke::new(1.0, t.border()))
                    .corner_radius(CornerRadius::same(crate::theme::RADIUS_XL))
                    .inner_margin(Margin::same(0))
                    .shadow(ctx.global_style().visuals.window_shadow),
            )
            .show(ctx, |ui| {
                ui.set_width(560.0);
                ui.spacing_mut().item_spacing = Vec2::new(0.0, 0.0);
                // ---- search row with the back arrow
                Frame::new().inner_margin(Margin { left: 12, right: 16, top: 10, bottom: 10 }).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        let b = w::btn(ic::ARROW_LEFT).muted().icon_sm().enabled(ap.step != Step::Sources).show(ui);
                        if b.clicked() {
                            ap.step = Step::Sources;
                            ap.query.clear();
                            ap.sel = 0;
                        }
                        let hint = match ap.step {
                            Step::Sources => "Search…",
                            Step::New => "Project name",
                            Step::Local => "Filter, or type a path (~/…)",
                            Step::Url => "https://… or git@…",
                            Step::GitHub => "Search your repositories, or type owner/repo",
                        };
                        let r = egui::TextEdit::singleline(&mut ap.query)
                            .id(search_id)
                            .hint_text(egui::WidgetText::from(hint).color(t.subtle()))
                            .font(crate::theme::ts("label-14"))
                            .frame(Frame::NONE.inner_margin(Margin::symmetric(4, 6)))
                            .desired_width(ui.available_width())
                            .show(ui)
                            .response
                            .response;
                        if r.changed() {
                            ap.sel = 0;
                            ap.error = None;
                        }
                        if ap.focus {
                            r.request_focus();
                            ap.focus = false;
                        }
                    });
                });
                ui.painter().hline(ui.min_rect().x_range(), ui.min_rect().bottom(), Stroke::new(1.0, t.border()));

                // ---- list
                Frame::new().inner_margin(Margin::symmetric(8, 8)).show(ui, |ui| {
                    ui.set_min_height(300.0);
                    let label = match ap.step {
                        Step::Sources => "Sources",
                        Step::New => "New project",
                        Step::Local => "Local folder",
                        Step::Url => "Git URL",
                        Step::GitHub => "GitHub repository",
                    };
                    ui.add_space(4.0);
                    ui.horizontal(|ui| {
                        ui.add_space(10.0);
                        w::subtle(ui, label, "label-12");
                    });
                    ui.add_space(6.0);
                    if let Some(b) = &ap.busy {
                        status_line(ui, &t, b, None);
                    }
                    if let Some(e) = &ap.error {
                        status_line(ui, &t, e, Some(t.red(900)));
                    }
                    if ap.step == Step::GitHub {
                        match &ap.gh {
                            Some(Err(e)) => status_line(ui, &t, &format!("gh: {e}"), Some(t.amber(900))),
                            _ if ap.gh_loading => status_line(ui, &t, "Loading your repositories…", None),
                            _ => {}
                        }
                    }
                    if rows.is_empty() && ap.busy.is_none() && act.is_none() && !ap.gh_loading {
                        let empty = match ap.step {
                            Step::New => "Type a name, then Enter",
                            Step::Url => "Paste a URL, then Enter",
                            _ => "No match",
                        };
                        status_line(ui, &t, empty, None);
                    }
                    ScrollArea::vertical().max_height(340.0).auto_shrink([false, true]).show(ui, |ui| {
                        for (i, row) in rows.iter().enumerate() {
                            let r = palette_row(ui, &t, row, i == ap.sel);
                            if r.hovered() && ui.input(|i| i.pointer.delta() != Vec2::ZERO) {
                                ap.sel = i;
                            }
                            if i == ap.sel && (up || down) {
                                r.scroll_to_me(None);
                            }
                            if r.clicked() && ap.busy.is_none() {
                                ap.sel = i;
                                act = Some(match &row.act {
                                    Act::Step(s) => Act::Step(*s),
                                    Act::Add(p) => Act::Add(p.clone()),
                                    Act::Browse => Act::Browse,
                                    Act::Create(n) => Act::Create(n.clone()),
                                    Act::Clone { url, name } => Act::Clone { url: url.clone(), name: name.clone() },
                                });
                            }
                        }
                    });
                });

                // ---- footer: keyboard hints
                let (fr, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 40.0), Sense::hover());
                let p = ui.painter();
                p.rect_filled(fr, CornerRadius { nw: 0, ne: 0, sw: crate::theme::RADIUS_XL, se: crate::theme::RADIUS_XL }, t.bg200);
                p.hline(fr.x_range(), fr.top(), Stroke::new(1.0, t.border()));
                let mut x = fr.left() + 16.0;
                for (k, l) in [("↑ ↓", "Navigate"), ("Enter", "Select"), ("Backspace", "Back"), ("Esc", "Close")] {
                    let kg = p.layout_no_wrap(k.into(), FontId::new(11.5, egui::FontFamily::Monospace), t.subtle());
                    let kr = Rect::from_min_size(pos2(x, fr.center().y - 10.0), Vec2::new(kg.size().x + 10.0, 20.0));
                    p.rect(kr, CornerRadius::same(4), t.gray(100), Stroke::new(1.0, t.border()), egui::StrokeKind::Inside);
                    p.galley(pos2(kr.left() + 5.0, kr.center().y - kg.size().y / 2.0), kg, t.subtle());
                    let lg = p.layout_no_wrap(l.into(), FontId::proportional(13.0), t.subtle());
                    p.galley(pos2(kr.right() + 6.0, fr.center().y - lg.size().y / 2.0), lg.clone(), t.subtle());
                    x = kr.right() + 6.0 + lg.size().x + 18.0;
                }
            });
        if modal.should_close() {
            close = true;
        }
        if !close {
            self.add_project = Some(ap);
            if let Some(a) = act {
                self.run(a, ctx);
            }
        } else {
            self.focus_composer = true;
        }
    }
}

fn status_line(ui: &mut Ui, t: &crate::theme::Tokens, text: &str, color: Option<egui::Color32>) {
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.label(egui::RichText::new(text).size(13.0).color(color.unwrap_or(t.subtle())));
    });
    ui.add_space(6.0);
}

fn palette_row(ui: &mut Ui, t: &crate::theme::Tokens, row: &Row, selected: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 52.0), Sense::click());
    let p = ui.painter();
    if selected {
        p.rect_filled(rect, CornerRadius::same(crate::theme::RADIUS_MD), t.accent());
    }
    let ic_c = pos2(rect.left() + 20.0, rect.center().y);
    match row.icon {
        Icon::Glyph(g) => ic::glyph(p, ic_c, g, 17.0, t.subtle()),
        Icon::GitHub => {
            crate::logos::paint(ui, p, Rect::from_center_size(ic_c, Vec2::splat(17.0)), "github", t);
        }
    }
    let x = rect.left() + 42.0;
    let max = rect.right() - x - 10.0;
    let tg = w::truncated(ui, &row.title, FontId::new(14.0, crate::theme::medium()), t.fg(), max);
    let dg = w::truncated(ui, &row.detail, FontId::proportional(12.5), t.subtle(), max);
    p.galley(pos2(x, rect.top() + 8.0), tg, t.fg());
    p.galley(pos2(x, rect.top() + 28.0), dg, t.subtle());
    resp.on_hover_cursor(egui::CursorIcon::PointingHand)
}

/// Sends a background result and wakes the UI to show it.
struct Waker {
    tx: std::sync::mpsc::Sender<Bg>,
    ctx: egui::Context,
}

impl Waker {
    fn send(&self, m: Bg) {
        let _ = self.tx.send(m);
        self.ctx.request_repaint();
    }
}

/// Your repositories and your organisations' ones, via `gh`.
fn gh_repos() -> Result<Vec<(String, String)>, String> {
    let list = |owner: Option<&str>| -> Result<Vec<(String, String)>, String> {
        let mut cmd = std::process::Command::new("gh");
        cmd.args(["repo", "list"]);
        if let Some(o) = owner {
            cmd.arg(o);
        }
        let o = cmd.args(["--limit", "300", "--json", "nameWithOwner,description"]).output().map_err(|e| format!("gh: {e}"))?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
        }
        let v: serde_json::Value = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
        Ok(v.as_array().into_iter().flatten().map(|r| (r["nameWithOwner"].as_str().unwrap_or("").to_string(), r["description"].as_str().unwrap_or("").to_string())).collect())
    };
    let mut all = list(None)?;
    let orgs = std::process::Command::new("gh").args(["org", "list"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    for org in orgs.lines().map(str::trim).filter(|l| !l.is_empty()) {
        all.extend(list(Some(org)).unwrap_or_default());
    }
    Ok(all)
}

/// "owner/repo" of a repository's github.com origin, read from .git/config.
fn github_slug(repo: &Path) -> Option<String> {
    let cfg = std::fs::read_to_string(repo.join(".git/config")).ok()?;
    let mut in_origin = false;
    for l in cfg.lines().map(str::trim) {
        if l.starts_with('[') {
            in_origin = l == "[remote \"origin\"]";
        } else if in_origin && let Some(url) = l.strip_prefix("url = ") {
            let rest = url.strip_prefix("git@github.com:").or_else(|| url.split_once("github.com/").map(|(_, r)| r))?;
            return Some(rest.trim_end_matches('/').trim_end_matches(".git").to_lowercase());
        }
    }
    None
}
