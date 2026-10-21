use crate::agent::{self, Event};
use crate::control;
use crate::git;
use crate::providers::{self, Account, Kind, Model};
use crate::store::{self, Chat, Item, Repo, Store};
use crate::theme::{Mode, Theme};
use crate::widgets::TokensCell;
use eframe::egui::{self, Frame, Id, Key, Margin, Stroke, Ui};
use egui_commonmark::CommonMarkCache;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

pub const CONTENT_W: f32 = 760.0;
/// Responsive layout (T3 Code's numbers): below `NARROW_W` the sidebar stops
/// docking and opens as a drawer; side panels dock only while the chat keeps
/// `CHAT_MIN_W`, otherwise they open as drawers over it.
pub const NARROW_W: f32 = 768.0;
pub const CHAT_MIN_W: f32 = 440.0;
pub const SIDEBAR_W: f32 = 272.0;
pub const TEAM_W: f32 = 300.0;
/// Composer/attachment key of the new-chat screen.
pub const DRAFT: i64 = 0;

#[derive(Default)]
pub struct Transcript {
    pub items: Vec<Item>,
    pub pending_text: Option<usize>,
    pub pending_thinking: Option<usize>,
    pub mcp: Vec<(String, String)>,
    pub stderr: Vec<String>,
    pub got_result: bool,
}

#[derive(Clone, Copy, PartialEq)]
pub enum View {
    /// "What should we work on?" — a chat that does not exist until the first message.
    Draft,
    Chat(i64),
    Settings(Tab),
    Usage,
    Prs,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Tab {
    General,
    Appearance,
    Keybindings,
    Providers,
    Limits,
    Integrations,
    Webhooks,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Popup {
    Model,
    Effort,
    Access,
    Project,
    Filter,
    /// Snooze menu for `App::snooze_for` (a chat or a project).
    Snooze,
}

pub enum Dialog {
    Rename { chat: i64, title: String },
    DeleteChat(i64),
    RemoveRepo(i64),
    /// Confirms stopping a lead and its running subagents.
    StopAll(i64),
}

pub enum Bg {
    Files(i64, Vec<PathBuf>),
    CursorModels(Vec<Model>),
    Prs(PathBuf, Result<Vec<serde_json::Value>, String>),
    Funnel(Option<String>),
    Avatar(i64, Option<egui::ColorImage>),
    GhRepos(Result<Vec<(String, String)>, String>),
    Cloned(Result<PathBuf, String>),
}

/// Account, model, effort and access of a chat or of the draft.
#[derive(Clone, PartialEq)]
pub struct Sel {
    pub account: String,
    pub model: String,
    pub effort: String,
    pub access: String,
}

pub struct Draft {
    pub repo: Option<i64>,
    pub sel: Sel,
}

#[derive(Default)]
pub struct Picker {
    /// None = favourites; Some(account id).
    pub rail: Option<String>,
    pub search: String,
    pub more: bool,
    pub hover: usize,
    pub just_opened: bool,
}

#[derive(Default)]
pub struct Prs {
    pub repo: Option<i64>,
    pub loading: bool,
    pub list: Option<Result<Vec<serde_json::Value>, String>>,
}

pub struct App {
    pub store: Store,
    pub theme: Theme,
    pub repos: Vec<Repo>,
    pub chats: Vec<Chat>,
    pub accounts: Vec<Account>,
    pub models: HashMap<Kind, Vec<Model>>,
    pub view: View,
    pub draft: Draft,
    pub transcripts: HashMap<i64, Transcript>,
    pub drafts: HashMap<i64, String>,
    pub files: HashMap<i64, Vec<PathBuf>>,
    pub mentions: crate::mentions::State,
    pub forks: crate::fork::State,
    pub turns: HashMap<i64, (agent::Turn, Instant)>,
    pub unread: HashSet<i64>,
    /// Unread chats whose last turn ended in an error (shown as Failed).
    pub failed: HashSet<i64>,
    /// Hidden until a time: "c<chat id>" / "r<project id>" → unix seconds.
    pub snoozed: HashMap<String, i64>,
    pub snooze_for: String,
    pub add_project: Option<crate::addproject::AddProject>,
    /// Project icons: the project's website icon (None = none, use a monogram).
    pub avatars: HashMap<i64, Option<egui::TextureHandle>>,
    pub(crate) tx: Sender<(i64, Event)>,
    rx: Receiver<(i64, Event)>,
    pub bg_tx: Sender<Bg>,
    bg_rx: Receiver<Bg>,
    pub git: HashMap<i64, Option<git::Status>>,
    pub collapsed: HashSet<i64>,
    pub expanded_tools: HashSet<(i64, usize)>,
    pub md: CommonMarkCache,
    pub dialog: Option<Dialog>,
    pub popup: Option<Popup>,
    pub popup_anchor: egui::Rect,
    pub picker: Picker,
    pub prs: Prs,
    pub search: String,
    pub settled_open: bool,
    pub favorites: Vec<(String, String)>,
    /// Surface panes, right and bottom (both can be open), and which is maximized.
    pub panes: [crate::surface::Pane; 2],
    pub surface_max: Option<crate::surface::Dock>,
    pub surface_menu: Option<(crate::surface::Dock, egui::Rect)>,
    pub focus_composer: bool,
    pub undo: crate::undo::State,
    pub queue: crate::queue::State,
    pub limits: crate::limits::State,
    /// Prompts waiting for a chat's current turn to end.
    pub pending: HashMap<i64, Vec<String>>,
    pub auto_turns: HashMap<i64, VecDeque<Instant>>,
    /// Projects whose automatic turns hit the hourly limit.
    pub paused: HashSet<i64>,
    pub timers: Vec<store::Timer>,
    pub webhooks: Vec<store::Webhook>,
    pub hook_tokens: Arc<Mutex<HashSet<String>>>,
    pub hook_port: Option<u16>,
    /// Public base of /hooks when Tailscale Funnel serves it.
    pub funnel: Option<String>,
    inc_rx: Receiver<control::Incoming>,
    pub order_by_activity: bool,
    /// Fast mode for Claude and Codex turns.
    pub fast: bool,
    /// The team panel beside a lead's thread.
    pub show_team: bool,
    pub sidebar_open: bool,
    /// Narrow windows: the sidebar / team panel shown as a drawer over the chat.
    pub sidebar_drawer: bool,
    pub team_drawer: bool,
    /// Whether the team panel fits beside the chat (decided each frame).
    pub team_docks: bool,
    /// A new build of Harbor is on disk; reload when it's a good moment.
    pub update_ready: Arc<std::sync::atomic::AtomicBool>,
    pub hold_reload: bool,
    /// Long-running processes Harbor owns (dev servers, watchers, data pulls).
    pub procs: Vec<crate::procs::Proc>,
    pub proc_tx: Sender<crate::procs::ProcEvent>,
    proc_rx: Receiver<crate::procs::ProcEvent>,
    pub expanded_procs: HashSet<i64>,
    pub keys: crate::keys::Keys,
    /// Where Settings' Back goes: the view open before Settings.
    pub settings_back: View,
    /// Chats whose turn was cut off while Harbor was away (the runner died, as in a
    /// reboot): they continue when its replay ends, if `resume_on_restart` is on.
    pub cut_off: HashSet<i64>,
}

impl App {
    pub fn new(ctx: &egui::Context) -> Self {
        let store = Store::open().expect("open database");
        let theme = Theme::new(Mode::parse(&store.get("theme").unwrap_or_default()));
        theme.apply(ctx);
        let (tx, rx) = channel();
        let (bg_tx, bg_rx) = channel();
        let (inc_tx, inc_rx) = channel();
        let (proc_tx, proc_rx) = channel();
        let accounts = providers::discover();
        let mut models = HashMap::new();
        for k in Kind::ALL {
            models.insert(k, providers::static_models(k));
        }
        let get = |k: &str, d: &str| store.get(k).unwrap_or_else(|| d.to_string());
        // Older builds stored Claude aliases.
        let model = match get("default_model", "claude-opus-5-5").as_str() {
            "opus" | "" => "claude-opus-5-5".to_string(),
            "sonnet" => "claude-sonnet-5-5".to_string(),
            "haiku" => "claude-haiku-5-5".to_string(),
            m => m.to_string(),
        };
        let sel = Sel {
            account: get("default_account", "claude"),
            model,
            effort: get("default_effort", ""),
            access: get("default_access", "full"),
        };
        let favorites = get("favorites", "")
            .split(',')
            .filter_map(|x| x.split_once('|'))
            .map(|(a, m)| (a.to_string(), m.to_string()))
            .collect();
        let collapsed = get("collapsed", "").split(',').filter_map(|x| x.parse().ok()).collect();
        let draft = Draft { repo: get("draft_repo", "").parse().ok(), sel };
        let mut app = Self {
            repos: store.repos(),
            chats: store.chats(),
            draft,
            store,
            theme,
            accounts,
            models,
            view: View::Draft,
            transcripts: HashMap::new(),
            drafts: HashMap::new(),
            files: HashMap::new(),
            mentions: Default::default(),
            forks: Default::default(),
            turns: HashMap::new(),
            unread: HashSet::new(),
            failed: HashSet::new(),
            snoozed: HashMap::new(),
            snooze_for: String::new(),
            add_project: None,
            avatars: HashMap::new(),
            tx,
            rx,
            bg_tx,
            bg_rx,
            git: HashMap::new(),
            collapsed,
            expanded_tools: HashSet::new(),
            md: CommonMarkCache::default(),
            dialog: None,
            popup: None,
            popup_anchor: egui::Rect::NOTHING,
            picker: Picker::default(),
            prs: Prs::default(),
            search: String::new(),
            settled_open: false,
            favorites,
            panes: Default::default(),
            surface_max: None,
            surface_menu: None,
            focus_composer: true,
            undo: Default::default(),
            queue: Default::default(),
            limits: Default::default(),
            pending: HashMap::new(),
            auto_turns: HashMap::new(),
            paused: HashSet::new(),
            timers: vec![],
            webhooks: vec![],
            hook_tokens: Arc::new(Mutex::new(HashSet::new())),
            hook_port: None,
            funnel: None,
            inc_rx,
            order_by_activity: false,
            fast: false,
            show_team: true,
            sidebar_open: true,
            sidebar_drawer: false,
            team_drawer: false,
            team_docks: true,
            update_ready: crate::reload::new_flag(),
            hold_reload: false,
            procs: vec![],
            proc_tx,
            proc_rx,
            expanded_procs: HashSet::new(),
            keys: Default::default(),
            settings_back: View::Draft,
            cut_off: HashSet::new(),
        };
        app.keys = crate::keys::Keys::load(&app.store);
        app.timers = app.store.timers();
        app.webhooks = app.store.webhooks();
        app.sync_tokens();
        app.order_by_activity = app.store.get("order_by_activity").as_deref() == Some("1");
        app.fast = app.store.get("fast_mode").as_deref() == Some("1");
        app.show_team = app.store.get("show_team").as_deref() != Some("0");
        app.sidebar_open = app.store.get("sidebar_open").as_deref() != Some("0");
        let wake = {
            let ctx = ctx.clone();
            move || ctx.request_repaint()
        };
        if let Ok(exe) = std::env::current_exe() {
            crate::reload::watch(exe, app.update_ready.clone(), wake.clone());
        }
        // Dev servers and other processes keep running across Harbor restarts.
        app.procs = crate::procs::adopt(&app.store, app.proc_tx.clone(), wake.clone());
        control::start_socket(inc_tx.clone(), wake.clone());
        app.hook_port = control::start_hooks(inc_tx, app.hook_tokens.clone(), wake);
        app.check_funnel();
        app.restore_after_reload(ctx);
        // Agent turns run detached: the ones still going (or done meanwhile) come back.
        app.reattach_turns(ctx);
        // Chats waiting out a usage limit, and what they queued.
        app.limits_load();
        // Harbor opens on the main page: "No project / New thread".
        app.draft.repo = None;
        if let Ok(v) = std::env::var("HARBOR_VIEW") {
            app.debug_view(ctx, &v);
        }
        app.load_cursor_models();
        app.load_snoozed();
        app
    }

    /// Development aid for screenshots: HARBOR_VIEW=draft|picker|settings|usage|prs|terminal,
    /// or a settings page (general, appearance, keybindings, providers, limits, …).
    fn debug_view(&mut self, ctx: &egui::Context, v: &str) {
        match v {
            "draft" => self.open(View::Draft),
            "addproject" => self.open_add_project(),
            "project" => {
                if let Some(r) = self.repos.first().map(|r| r.id) {
                    self.open_project(r);
                }
            }
            "picker" => {
                self.open(View::Draft);
                self.popup = Some(Popup::Model);
                self.picker = Picker { rail: Some(self.draft.sel.account.clone()), just_opened: true, ..Default::default() };
            }
            "effort" => {
                if let Some(r) = self.repos.first().map(|r| r.id) {
                    self.open_project(r);
                }
                self.popup = Some(Popup::Effort);
            }
            // Narrow-layout drawers (they close again where they'd dock).
            "team" | "sidebar" => {
                if let Some(r) = self.repos.first().map(|r| r.id) {
                    self.open_project(r);
                }
                self.team_drawer = v == "team";
                self.sidebar_drawer = v == "sidebar";
            }
            "settings" => self.open(View::Settings(Tab::General)),
            "usage" => self.open(View::Usage),
            "prs" => self.open(View::Prs),
            "terminal" => self.toggle_terminal(ctx),
            "browser" => {
                if let Some(r) = self.repos.first().map(|r| r.id) {
                    self.open_project(r);
                }
                self.open_browser(None);
            }
            "panes" => {
                if let Some(r) = self.repos.first().map(|r| r.id) {
                    self.open_project(r);
                }
                self.toggle_dock(crate::surface::Dock::Right);
                self.toggle_dock(crate::surface::Dock::Bottom);
            }
            "surface" => {
                if let Some(r) = self.repos.first().map(|r| r.id) {
                    self.open_project(r);
                }
                self.toggle_dock(crate::surface::Dock::Right);
            }
            v => {
                if let Some(tab) = Tab::from_slug(v) {
                    self.open(View::Settings(tab));
                }
            }
        }
    }

    // ------------------------------------------------------------ lookups

    pub fn chat(&self, id: i64) -> Option<&Chat> {
        self.chats.iter().find(|c| c.id == id)
    }

    pub fn chat_mut(&mut self, id: i64) -> Option<&mut Chat> {
        self.chats.iter_mut().find(|c| c.id == id)
    }

    pub fn repo(&self, id: i64) -> Option<&Repo> {
        self.repos.iter().find(|r| r.id == id)
    }

    pub fn account(&self, id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == id)
    }

    pub fn models_for(&self, kind: Kind) -> &[Model] {
        self.models.get(&kind).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn model_label(&self, kind: Kind, id: &str) -> String {
        self.models_for(kind)
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.label.clone())
            .unwrap_or_else(|| if id.is_empty() { "Default".into() } else { id.into() })
    }

    /// Project of the current view (chat's project, or the draft's).
    pub fn current_repo(&self) -> Option<i64> {
        match self.view {
            View::Chat(c) => self.chat(c).and_then(|c| c.repo_id),
            _ => self.draft.repo,
        }
    }

    pub fn cwd_of(&self, repo: Option<i64>) -> PathBuf {
        repo.and_then(|r| self.repo(r)).map(|r| r.path.clone()).unwrap_or_else(store::home)
    }

    pub fn key(&self) -> i64 {
        match self.view {
            View::Chat(id) => id,
            _ => DRAFT,
        }
    }

    pub fn sel(&self) -> Sel {
        match self.view {
            View::Chat(id) => self
                .chat(id)
                .map(|c| Sel { account: c.account.clone(), model: c.model.clone(), effort: c.effort.clone(), access: c.access.clone() })
                .unwrap_or_else(|| self.draft.sel.clone()),
            _ => self.draft.sel.clone(),
        }
    }

    pub fn set_sel(&mut self, mut s: Sel) {
        // Keep effort/access valid for the provider.
        if let Some(kind) = self.account(&s.account).map(|a| a.kind) {
            if !providers::efforts(kind).iter().any(|e| e.0 == s.effort) {
                s.effort = providers::default_effort(kind).into();
            }
            if !providers::access(kind).iter().any(|a| a.0 == s.access) {
                s.access = providers::access(kind)[0].0.into();
            }
        }
        for (k, v) in [("default_account", &s.account), ("default_model", &s.model), ("default_effort", &s.effort), ("default_access", &s.access)] {
            self.store.set(k, v);
        }
        self.draft.sel = s.clone();
        if let View::Chat(id) = self.view {
            if let Some(c) = self.chat_mut(id) {
                c.account = s.account;
                c.model = s.model;
                c.effort = s.effort;
                c.access = s.access;
                let c = c.clone();
                self.store.save_chat(&c);
            }
        }
    }

    /// A started chat can only switch within its provider (Claude accounts share sessions).
    pub fn locked_kind(&self) -> Option<Kind> {
        let View::Chat(id) = self.view else { return None };
        let c = self.chat(id)?;
        if c.role == store::Role::Lead {
            // The lead needs Harbor's tools through --mcp-config; Claude for now.
            return Some(Kind::Claude);
        }
        if !c.started {
            return None;
        }
        self.account(&c.account).map(|a| a.kind)
    }

    pub fn is_favorite(&self, account: &str, model: &str) -> bool {
        self.favorites.iter().any(|(a, m)| a == account && m == model)
    }

    pub fn toggle_favorite(&mut self, account: &str, model: &str) {
        if self.is_favorite(account, model) {
            self.favorites.retain(|(a, m)| !(a == account && m == model));
        } else {
            self.favorites.push((account.into(), model.into()));
        }
        let s: Vec<String> = self.favorites.iter().map(|(a, m)| format!("{a}|{m}")).collect();
        self.store.set("favorites", &s.join(","));
    }

    // ------------------------------------------------------------ navigation

    pub fn open(&mut self, view: View) {
        if matches!(view, View::Settings(_)) && !matches!(self.view, View::Settings(_)) {
            self.settings_back = self.view;
        }
        self.view = view;
        self.popup = None;
        match view {
            View::Chat(id) => {
                self.unread.remove(&id);
                self.failed.remove(&id);
                if !self.transcripts.contains_key(&id) {
                    let items = self.store.items(id);
                    self.transcripts.insert(id, Transcript { items, ..Default::default() });
                }
                if let Some(repo) = self.chat(id).and_then(|c| c.repo_id) {
                    self.refresh_git(repo);
                }
                self.store.set("last_chat", &id.to_string());
                self.focus_composer = true;
            }
            View::Draft => {
                if let Some(r) = self.draft.repo {
                    self.refresh_git(r);
                }
                self.focus_composer = true;
            }
            View::Prs => {
                if self.prs.repo.is_none() {
                    self.prs.repo = self.current_repo().or(self.repos.first().map(|r| r.id));
                }
                self.load_prs();
            }
            _ => {}
        }
    }

    /// The main page ("project / New thread"); the first message creates the chat.
    pub fn new_draft(&mut self, repo: Option<i64>) {
        self.draft.repo = repo;
        self.store.set("draft_repo", &repo.map(|r| r.to_string()).unwrap_or_default());
        if let Some(r) = repo {
            self.collapsed.remove(&r);
        }
        self.open(View::Draft);
    }

    pub fn refresh_git(&mut self, repo_id: i64) {
        if let Some(r) = self.repo(repo_id) {
            let s = git::status(&r.path);
            self.git.insert(repo_id, s);
        }
    }

    pub fn refresh_all(&mut self) {
        self.accounts = providers::discover();
        self.models.insert(Kind::Codex, providers::codex_models());
        self.load_cursor_models();
        self.repos = self.store.repos();
        let ids: Vec<i64> = self.repos.iter().map(|r| r.id).collect();
        for id in ids {
            self.refresh_git(id);
        }
        if self.view == View::Prs {
            self.load_prs();
        }
    }

    pub fn check_funnel(&self) {
        let port = self.hook_port.unwrap_or(control::HOOK_PORT);
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Bg::Funnel(control::funnel_base(port)));
        });
    }

    fn load_cursor_models(&self) {
        let Some(bin) = self.account("cursor").and_then(|a| a.bin.clone()) else { return };
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Bg::CursorModels(providers::cursor_models(&bin)));
        });
    }

    pub fn load_prs(&mut self) {
        let Some(path) = self.prs.repo.and_then(|r| self.repo(r)).map(|r| r.path.clone()) else { return };
        self.prs.loading = true;
        self.prs.list = None;
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            let out = std::process::Command::new("gh")
                .args(["pr", "list", "--limit", "40", "--json", "number,title,headRefName,author,isDraft,reviewDecision,updatedAt,url,additions,deletions"])
                .current_dir(&path)
                .env("PATH", providers::child_path())
                .output();
            let r = match out {
                Ok(o) if o.status.success() => serde_json::from_slice::<Vec<serde_json::Value>>(&o.stdout).map_err(|e| e.to_string()),
                Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
                Err(e) => Err(format!("gh: {e}")),
            };
            let _ = tx.send(Bg::Prs(path, r));
        });
    }

    /// Web links clicked anywhere in Harbor (agent replies, notices) open in the
    /// built-in browser pane instead of the system browser.
    fn route_links(&mut self, ctx: &egui::Context) {
        let mut urls = vec![];
        ctx.output_mut(|o| {
            o.commands.retain(|c| match c {
                egui::OutputCommand::OpenUrl(u) if u.url.starts_with("http://") || u.url.starts_with("https://") => {
                    urls.push(u.url.clone());
                    false
                }
                _ => true,
            })
        });
        if let Some(url) = urls.pop() {
            self.open_browser(Some(url));
        }
    }

    /// Ctrl+V of an image (a screenshot, an image copied in a browser) or of files
    /// copied in a file manager attaches them to the open composer instead of
    /// pasting text. The terminal and browser panes keep their own pastes.
    fn paste_attachments(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        if !matches!(self.view, View::Draft | View::Chat(_)) || self.dialog.is_some() {
            return;
        }
        let focused = ctx.memory(|m| m.focused());
        let pane = [crate::surface::Dock::Right, crate::surface::Dock::Bottom].iter().any(|d| focused == Some(crate::surface::term_id(*d)))
            || (0..2usize).any(|i| focused == Some(Id::NULL.with(("browser-page", i))));
        if pane {
            return;
        }
        let key = self.key();
        let mut added = false;
        raw.events.retain(|e| match e {
            egui::Event::PasteImage(img) => {
                match save_pasted_image(img) {
                    Ok(path) => self.files.entry(key).or_default().push(path),
                    Err(e) => eprintln!("harbor: paste image: {e}"),
                }
                added = true;
                false
            }
            egui::Event::Paste(text) => match copied_files(text) {
                Some(paths) => {
                    self.files.entry(key).or_default().extend(paths);
                    added = true;
                    false
                }
                None => true,
            },
            _ => true,
        });
        if added {
            self.focus_composer = true;
        }
    }

    pub fn pick_files(&self, key: i64) {
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            let out = std::process::Command::new("zenity")
                .args(["--file-selection", "--multiple", "--separator=\n", "--title=Attach files"])
                .output();
            if let Ok(o) = out {
                let files: Vec<PathBuf> =
                    String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect();
                if !files.is_empty() {
                    let _ = tx.send(Bg::Files(key, files));
                }
            }
        });
    }

    // ------------------------------------------------------------ terminal

    pub fn login(&mut self, ctx: &egui::Context, account_id: &str) {
        let Some(a) = self.account(account_id).cloned() else { return };
        let cwd = store::home();
        if !a.installed() {
            let argv = vec!["bash".into(), "-lc".into(), a.kind.install_hint().into()];
            self.open_terminal(ctx, &format!("Install {}", a.kind.label()), cwd, argv, vec![]);
            return;
        }
        let mut argv = vec![a.bin_str()];
        argv.extend(a.kind.login_cmd().iter().map(|s| s.to_string()));
        self.open_terminal(ctx, &format!("Sign in · {}", a.name), cwd, argv, a.env());
    }

    pub fn add_claude_account(&mut self, ctx: &egui::Context) {
        let n = (2..20).find(|n| !store::home().join(format!(".claude{n}")).exists()).unwrap_or(9);
        let dir = store::home().join(format!(".claude{n}"));
        let script = if providers::which("claude-profile").is_some() {
            format!("claude-profile --setup claude{n} && CLAUDE_CONFIG_DIR={} claude /login", dir.display())
        } else {
            format!("mkdir -p {0} && CLAUDE_CONFIG_DIR={0} claude /login", dir.display())
        };
        self.open_terminal(ctx, &format!("Claude account {n}"), store::home(), vec!["bash".into(), "-lc".into(), script], vec![]);
    }

    // ------------------------------------------------------------ turns

    /// The user's message from the composer. Drafts go to the chosen project's lead.
    pub fn send(&mut self, ctx: &egui::Context) {
        let key = self.key();
        let text = self.drafts.get(&key).map(|s| s.trim().to_string()).unwrap_or_default();
        let files = self.files.get(&key).cloned().unwrap_or_default();
        let mentions = self.mentions.drafts.get(&key).cloned().unwrap_or_default();
        if text.is_empty() && files.is_empty() && mentions.is_empty() {
            return;
        }
        let chat_id = if key == DRAFT {
            // A project can hold several chats: every send from the draft starts one.
            let id = self.new_thread(self.draft.repo, &text);
            self.view = View::Chat(id);
            self.store.set("last_chat", &id.to_string());
            id
        } else {
            key
        };
        self.drafts.remove(&key);
        self.files.remove(&key);
        self.mentions.drafts.remove(&key);
        if let Some(p) = self.chat(chat_id).and_then(|c| c.repo_id) {
            self.paused.remove(&p);
        }
        if self.turns.contains_key(&chat_id) {
            // Busy: it waits in the queue and joins the transcript once delivered.
            self.enqueue(chat_id, text, files, mentions);
            self.focus_composer = true;
            return;
        }
        let tr = self.transcripts.entry(chat_id).or_default();
        if tr.items.is_empty() {
            tr.items = self.store.items(chat_id);
        }
        let item = tr.items.len();
        tr.items.push(Item::User {
            text: text.clone(),
            files: files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            at: store::now(),
            mentions: mentions.clone(),
        });
        // Mentioned messages go first, quoted; the transcript shows them as chips.
        let quoted = crate::mentions::prompt(&mentions);
        // Anything queued for an idle chat goes first; a fork's context before all.
        let fork = self.take_fork_preamble(chat_id);
        let queued = self.pending.remove(&chat_id).filter(|q| !q.is_empty());
        let snap = self.undo_snapshot(chat_id, item, &text, &files, &mentions, queued.as_deref().unwrap_or_default());
        let prompt = match queued {
            Some(q) => format!("{fork}{}\n\n---\n\n{quoted}{text}", q.join("\n\n---\n\n")),
            None => format!("{fork}{quoted}{text}"),
        };
        self.start_turn(chat_id, prompt, files, ctx);
        self.undo_started(chat_id, snap);
        self.focus_composer = true;
    }

    /// Starts one agent turn for a chat (user message, report, wake-up, webhook…).
    pub fn start_turn(&mut self, chat_id: i64, prompt: String, files: Vec<PathBuf>, ctx: &egui::Context) {
        // One turn per chat. A runner still going for it, even one this Harbor lost
        // track of, holds the session: the prompt waits for that turn instead.
        if self.turns.contains_key(&chat_id) || self.adopt_runner(chat_id, ctx) {
            let mut p = prompt;
            for f in &files {
                p.push_str(&format!("\n(attached: {})", f.display()));
            }
            self.pending.entry(chat_id).or_default().push(p);
            self.persist(chat_id);
            return;
        }
        // An account at its usage limit takes no turns: the prompt waits for the reset.
        if self.limit_guard(chat_id, &prompt, &files) {
            return;
        }
        let Some(chat) = self.chat(chat_id).cloned() else { return };
        let Some(account) = self.account(&chat.account).cloned() else { return };
        if !self.transcripts.contains_key(&chat_id) {
            let items = self.store.items(chat_id);
            self.transcripts.insert(chat_id, Transcript { items, ..Default::default() });
        }
        let spec = agent::TurnSpec {
            chat_id,
            cwd: self.cwd_of(chat.repo_id),
            prompt,
            files,
            session_id: chat.session_id.clone(),
            resume: chat.started && !chat.session_id.is_empty(),
            account,
            model: chat.model.clone(),
            effort: chat.effort.clone(),
            access: chat.access.clone(),
            team: self.team_for(&chat),
            fast: self.fast,
            base: self.transcripts.get(&chat_id).map_or(0, |t| t.items.len()),
        };
        let wake = turn_wake(ctx, chat_id);
        let tr = self.transcripts.get_mut(&chat_id).unwrap();
        tr.got_result = false;
        tr.stderr.clear();
        tr.pending_text = None;
        tr.pending_thinking = None;
        match agent::start(spec, self.tx.clone(), wake) {
            Ok(turn) => {
                self.turns.insert(chat_id, (turn, Instant::now()));
            }
            Err(e) => tr.items.push(Item::Error { text: format!("Could not start the agent: {e}") }),
        }
        if let Some(c) = self.chat_mut(chat_id) {
            c.updated = store::now();
        }
        self.persist(chat_id);
    }

    pub fn persist(&mut self, chat_id: i64) {
        if let Some(c) = self.chat(chat_id).cloned() {
            self.store.save_chat(&c);
        }
        if let Some(t) = self.transcripts.get(&chat_id) {
            let items = t.items.clone();
            self.store.save_items(chat_id, &items);
        }
    }

    pub fn stop(&mut self, chat_id: i64) {
        if let Some((t, _)) = self.turns.remove(&chat_id) {
            t.stop();
            if let Some(tr) = self.transcripts.get_mut(&chat_id) {
                tr.items.push(Item::Error { text: "Stopped.".into() });
            }
            self.persist(chat_id);
        }
    }

    fn apply_event(&mut self, id: i64, ev: Event, ctx: &egui::Context) {
        if !self.transcripts.contains_key(&id) {
            let items = self.store.items(id);
            self.transcripts.insert(id, Transcript { items, ..Default::default() });
        }
        let (account, model) = self.chat(id).map(|c| (c.account.clone(), c.model.clone())).unwrap_or_default();
        let started_at = self.turns.get(&id).map(|(_, s)| *s);
        // A turn cut off by a restart that continues isn't reported as failed.
        let resumes = matches!(ev, Event::Exited { .. }) && self.resumes(id);
        let tr = self.transcripts.get_mut(&id).unwrap();
        match ev {
            Event::Session(sid) => {
                if let Some(c) = self.chats.iter_mut().find(|c| c.id == id) {
                    if !sid.is_empty() && (!c.started || c.session_id != sid) {
                        c.session_id = sid;
                        c.started = true;
                        self.store.save_chat(c);
                    }
                }
            }
            Event::Mcp(m) => tr.mcp = m,
            Event::TextDelta(d) => match tr.pending_text.and_then(|i| tr.items.get_mut(i)) {
                Some(Item::Text { text, .. }) => text.push_str(&d),
                _ => {
                    tr.items.push(Item::Text { text: d, at: store::now() });
                    tr.pending_text = Some(tr.items.len() - 1);
                }
            },
            Event::TextFinal(full) => match tr.pending_text.take().and_then(|i| tr.items.get_mut(i)) {
                Some(Item::Text { text, .. }) => *text = full,
                _ if !full.trim().is_empty() => tr.items.push(Item::Text { text: full, at: store::now() }),
                _ => {}
            },
            Event::ThinkingDelta(d) => match tr.pending_thinking.and_then(|i| tr.items.get_mut(i)) {
                Some(Item::Thinking { text }) => text.push_str(&d),
                _ => {
                    tr.items.push(Item::Thinking { text: d });
                    tr.pending_thinking = Some(tr.items.len() - 1);
                }
            },
            Event::ThinkingFinal(full) => match (tr.pending_thinking.take().and_then(|i| tr.items.get_mut(i)), full) {
                (Some(Item::Thinking { text }), Some(f)) => *text = f,
                (None, Some(f)) if !f.trim().is_empty() => tr.items.push(Item::Thinking { text: f }),
                _ => {}
            },
            Event::Tool { id: tid, name, summary, input, result, is_error } => {
                let existing = tr.items.iter_mut().rev().find(|it| matches!(it, Item::Tool { id, .. } if *id == tid));
                match existing {
                    Some(Item::Tool { name: n, summary: s, input: i, result: r, is_error: e, .. }) => {
                        if !name.is_empty() {
                            *n = name;
                        }
                        if !summary.is_empty() {
                            *s = summary;
                        }
                        if !input.is_empty() {
                            *i = input;
                        }
                        if result.is_some() {
                            *r = result;
                            *e = is_error;
                        }
                    }
                    _ => tr.items.push(Item::Tool { id: tid, name, summary, input, result, is_error }),
                }
                tr.pending_text = None;
            }
            Event::Result { cost_usd, duration_ms, turns, input_tokens, output_tokens } => {
                tr.got_result = true;
                let duration_ms =
                    if duration_ms == 0 { started_at.map(|s| s.elapsed().as_millis() as u64).unwrap_or(0) } else { duration_ms };
                tr.items.push(Item::Result {
                    cost_usd: cost_usd.unwrap_or(0.0),
                    duration_ms,
                    turns,
                    input_tokens,
                    output_tokens,
                    at: store::now(),
                    account,
                    model,
                });
            }
            Event::Error(e) => {
                if !e.trim().is_empty() {
                    tr.items.push(Item::Error { text: e });
                }
            }
            Event::Stderr(l) => {
                tr.stderr.push(l);
                if tr.stderr.len() > 40 {
                    tr.stderr.remove(0);
                }
            }
            Event::UserEcho(_) | Event::Limit { .. } | Event::Quota(_) => {}
            Event::Exited { ok } => {
                let stopped = self.turns.remove(&id).is_none();
                let failed = !stopped && !resumes && (!tr.got_result || matches!(tr.items.last(), Some(Item::Error { .. })));
                if !tr.got_result && !stopped && !resumes {
                    let tail = tr.stderr.join("\n");
                    let msg = if !tail.is_empty() {
                        tail
                    } else if ok {
                        "The agent exited without a result.".into()
                    } else {
                        "The agent exited with an error.".into()
                    };
                    tr.items.push(Item::Error { text: msg });
                }
                tr.pending_text = None;
                tr.pending_thinking = None;
                let visible = self.view == View::Chat(id) && ctx.input(|i| i.viewport().focused.unwrap_or(true));
                // Subagents work behind the lead: only the lead's replies notify.
                let sub = self.chat(id).is_some_and(|c| c.role == store::Role::Sub);
                if !visible && !sub && !resumes {
                    self.unread.insert(id);
                    if failed {
                        self.failed.insert(id);
                    } else {
                        self.failed.remove(&id);
                    }
                    let title = self.chat(id).map(|c| c.title.clone()).unwrap_or_default();
                    // Waited on a thread so finished notifiers don't linger as zombies.
                    std::thread::spawn(move || {
                        let _ = std::process::Command::new("notify-send").args(["-a", "Harbor", "Agent finished", &title]).status();
                    });
                }
                if let Some(c) = self.chat_mut(id) {
                    c.updated = store::now();
                }
                self.persist(id);
                if let Some(r) = self.chat(id).and_then(|c| c.repo_id) {
                    self.refresh_git(r);
                }
                self.after_turn(id, stopped, ctx);
            }
        }
    }
}

/// Writes a pasted image to Harbor's data dir as PNG, for the agent to read.
fn save_pasted_image(img: &egui::ColorImage) -> Result<PathBuf, String> {
    let dir = store::data_dir().join("pastes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("pasted-{stamp}.png"));
    let [w, h] = img.size;
    let rgba: Vec<u8> = img.pixels.iter().flat_map(|c| c.to_srgba_unmultiplied()).collect();
    image::save_buffer(&path, &rgba, w as u32, h as u32, image::ColorType::Rgba8).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Pasted text that is only `file://` URIs (files copied in a file manager): their paths.
fn copied_files(text: &str) -> Option<Vec<PathBuf>> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).collect();
    if lines.is_empty() || !lines.iter().all(|l| l.starts_with("file://")) {
        return None;
    }
    let paths: Vec<PathBuf> = lines.iter().map(|l| PathBuf::from(percent_decode(&l["file://".len()..]))).filter(|p| p.exists()).collect();
    (!paths.is_empty()).then_some(paths)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn ago(ts: i64) -> String {
    let d = (store::now() - ts).max(0);
    match d {
        0..60 => "now".into(),
        60..3600 => format!("{}m", d / 60),
        3600..86400 => format!("{}h", d / 3600),
        _ => format!("{}d", d / 86400),
    }
}

pub fn tilde(p: &std::path::Path) -> String {
    let h = store::home();
    match p.strip_prefix(&h) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => p.display().to_string(),
    }
}

pub fn clip(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut end = n;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} more bytes)", &s[..end], s.len() - end)
}

// ================================================================== frame

impl eframe::App for App {
    /// Development aid for headless screenshots: HARBOR_POINTER=x,y[,click|wheel[,secs]]
    /// places the pointer there and optionally clicks once after `secs` (default 1).
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        // A keybinding being set takes every key first: no clipboard key, shortcut or text field sees it.
        if self.keys.capture.is_some() && matches!(self.view, View::Settings(Tab::Keybindings)) {
            self.keys.capture_raw(raw, &self.store);
        }
        let focused = ctx.memory(|m| m.focused());
        let in_terminal = [crate::surface::Dock::Right, crate::surface::Dock::Bottom].iter().any(|d| focused == Some(crate::surface::term_id(*d)));
        // Browser pages and device screens copy their own selection on Ctrl+C/X.
        let keep_copy_keys = (0..2usize).any(|i| focused == Some(Id::NULL.with(("browser-page", i))) || focused == Some(Id::NULL.with(("device-view", i))));
        crate::clipboard::shortcuts(raw, in_terminal, keep_copy_keys);
        self.paste_attachments(ctx, raw);
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        static CLICKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let Ok(spec) = std::env::var("HARBOR_POINTER") else { return };
        let parts: Vec<&str> = spec.split(',').collect();
        let (Some(x), Some(y)) = (parts.first().and_then(|v| v.parse().ok()), parts.get(1).and_then(|v| v.parse().ok())) else { return };
        let pos = egui::pos2(x, y);
        raw.events.push(egui::Event::PointerMoved(pos));
        let start = START.get_or_init(Instant::now);
        let delay = parts.get(3).and_then(|v| v.parse().ok()).unwrap_or(1);
        if parts.get(2) == Some(&"wheel") && start.elapsed() > Duration::from_secs(delay) && !CLICKED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            raw.events.push(egui::Event::MouseWheel { unit: egui::MouseWheelUnit::Point, delta: egui::vec2(0.0, -400.0), phase: egui::TouchPhase::Move, modifiers: Default::default(), source: egui::MouseWheelSource::Wheel });
        }
        if parts.get(2) == Some(&"click") && start.elapsed() > Duration::from_secs(delay) && !CLICKED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            for pressed in [true, false] {
                raw.events.push(egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: Default::default() });
            }
        }
    }

    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok((id, ev)) = self.rx.try_recv() {
            if self.undo_swallows(id, &ev) || self.queue_event(id, &ev) || self.limit_event(id, &ev) {
                continue;
            }
            // A turn ends as a stop when it was already taken off `turns`.
            let exited = matches!(ev, Event::Exited { .. }).then(|| !self.turns.contains_key(&id));
            self.apply_event(id, ev, ctx);
            if let Some(stopped) = exited {
                self.queue_exited(id, stopped, ctx);
                self.limit_exited(id, ctx);
                self.restart_exited(id, ctx);
            }
        }
        while let Ok(m) = self.bg_rx.try_recv() {
            match m {
                Bg::Files(key, f) => self.files.entry(key).or_default().extend(f),
                m @ (Bg::GhRepos(_) | Bg::Cloned(_)) => self.add_project_bg(m),
                Bg::Avatar(repo, img) => {
                    let tex = img.map(|i| ctx.load_texture(format!("avatar-{repo}"), i, egui::TextureOptions::LINEAR));
                    self.avatars.insert(repo, tex);
                }
                Bg::CursorModels(m) => {
                    self.models.insert(Kind::Cursor, m);
                }
                Bg::Funnel(f) => self.funnel = f,
                Bg::Prs(path, r) => {
                    if self.prs.repo.and_then(|r| self.repo(r)).is_some_and(|r| r.path == path) {
                        self.prs.list = Some(r);
                        self.prs.loading = false;
                    }
                }
            }
        }
        while let Ok(e) = self.proc_rx.try_recv() {
            self.handle_proc_event(e, ctx);
        }
        while let Ok(m) = self.inc_rx.try_recv() {
            match m {
                control::Incoming::Tool(call) => self.handle_tool(call, ctx),
                control::Incoming::Hook(h) => self.handle_hook(h, ctx),
                control::Incoming::Focus { raised } => {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
                    ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
                    if !raised {
                        ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Critical));
                    }
                }
            }
        }
        if let Some(next) = self.fire_timers(ctx) {
            ctx.request_repaint_after(next);
        }
        if let Some(next) = self.fire_limit_timers(ctx) {
            ctx.request_repaint_after(next);
        }
        crate::update::tick(self.auto_update(), ctx);
        let dropped: Vec<PathBuf> = ctx.input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).filter(|p| !p.as_os_str().is_empty()).collect());
        if !dropped.is_empty() && !crate::devices::claims_drop(ctx) {
            let key = self.key();
            self.files.entry(key).or_default().extend(dropped);
        }
        if !self.turns.is_empty() {
            ctx.request_repaint_after(Duration::from_millis(500));
        }
        // Agent events repaint at once for the chat on screen (see turn_wake).
        let hidden = ctx.input(|i| i.viewport().minimized == Some(true) || i.viewport().occluded == Some(true));
        let shown = match self.view {
            View::Chat(id) if !hidden => id,
            _ => 0,
        };
        agent::SHOWN_CHAT.store(shown, std::sync::atomic::Ordering::Relaxed);
        self.wake_snoozed(ctx);
        self.maybe_reload(ctx);
    }

    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.theme.refresh(&ctx);
        ctx.data_mut(|d| d.insert_temp(Id::NULL, TokensCell(self.theme.t)));
        self.shortcuts(&ctx);

        let t = self.theme.t;
        let narrow = self.sidebar_narrow(&ctx);
        if !narrow {
            self.sidebar_drawer = false;
        }
        if self.sidebar_open && !narrow {
            egui::Panel::left("sidebar")
                .exact_size(SIDEBAR_W)
                .resizable(false)
                .show_separator_line(false)
                .frame(Frame::new().fill(t.bg200).inner_margin(Margin::symmetric(10, 10)).stroke(Stroke::new(1.0, t.border())))
                .show(ui, |ui| self.sidebar(ui));
        } else if !matches!(self.view, View::Draft | View::Chat(_) | View::Settings(_)) {
            // Pages without the top bar still need a way back to the sidebar.
            egui::Area::new(Id::NULL.with("sidebar-reopen")).fixed_pos(egui::pos2(10.0, 10.0)).order(egui::Order::Foreground).show(&ctx, |ui| {
                if crate::widgets::btn(crate::icons::PANEL_LEFT).muted().icon_sm().show(ui).on_hover_text(self.key_hint("Show sidebar", "toggle_sidebar")).clicked() {
                    self.toggle_sidebar(&ctx);
                }
            });
        }

        // Surface panes (browser, terminals, device): right and/or bottom, or one maximized.
        use crate::surface::Dock;
        if let Some(d) = self.surface_max {
            if self.pane(d).open {
                egui::CentralPanel::default().frame(Frame::new().fill(t.bg200)).show(ui, |ui| self.pane_ui(ui, d));
                self.popups(&ctx);
                self.dialogs(&ctx);
                self.add_project_ui(&ctx);
                self.route_links(&ctx);
                crate::images::lightbox(&ctx);
                return;
            }
            self.surface_max = None;
        }
        if self.pane(Dock::Right).open {
            // Never squeeze the chat below its minimum: the pane gives way first.
            let room = ui.available_width() - CHAT_MIN_W;
            egui::Panel::right("surface-right")
                .resizable(true)
                .default_size(620.0)
                .min_size(320.0)
                .max_size(room.max(320.0))
                .show_separator_line(true)
                .frame(Frame::new().fill(t.bg200))
                .show(ui, |ui| self.pane_ui(ui, Dock::Right));
        }
        if self.pane(Dock::Bottom).open {
            egui::Panel::bottom("surface-bottom")
                .resizable(true)
                .default_size(300.0)
                .min_size(140.0)
                .show_separator_line(true)
                .frame(Frame::new().fill(t.bg200))
                .show(ui, |ui| self.pane_ui(ui, Dock::Bottom));
        }

        egui::CentralPanel::default().frame(Frame::new().fill(t.bg100)).show(ui, |ui| match self.view {
            View::Draft => self.draft_view(ui),
            View::Chat(id) => self.chat_view(ui, id),
            View::Settings(tab) => self.settings(ui, tab),
            View::Usage => self.usage(ui),
            View::Prs => self.prs_view(ui),
        });

        if self.sidebar_drawer {
            let view = self.view;
            let frame = Frame::new().fill(t.bg200).inner_margin(Margin::symmetric(10, 10)).stroke(Stroke::new(1.0, t.border()));
            let close = drawer(&ctx, "sidebar", true, SIDEBAR_W, frame, |ui| self.sidebar(ui));
            // Picking a thread or page closes the drawer, as on T3 Code's mobile layout.
            if close || self.view != view {
                self.sidebar_drawer = false;
            }
        }

        self.popups(&ctx);
        self.dialogs(&ctx);
        self.add_project_ui(&ctx);
        self.route_links(&ctx);
        crate::images::lightbox(&ctx);
    }
}

/// A side panel over the window, for layouts with no room to dock it: an
/// opaque panel on one edge over a scrim. Returns true when a click on the
/// scrim (or Esc, see `shortcuts`) should close it.
pub fn drawer(ctx: &egui::Context, id: &str, left: bool, width: f32, frame: Frame, add: impl FnOnce(&mut Ui)) -> bool {
    let screen = ctx.content_rect();
    let w = width.min(screen.width() * 0.88);
    let panel = if left {
        egui::Rect::from_min_size(screen.min, egui::vec2(w, screen.height()))
    } else {
        egui::Rect::from_min_max(egui::pos2(screen.right() - w, screen.top()), screen.max)
    };
    let mut close = false;
    let area = egui::Area::new(Id::NULL.with(("drawer", id))).order(egui::Order::Middle).fixed_pos(screen.min).show(ctx, |ui| {
        ui.expand_to_include_rect(screen);
        let scrim = ui.interact(screen, Id::NULL.with(("drawer-scrim", id)), egui::Sense::click());
        ui.painter().rect_filled(screen, 0.0, egui::Color32::from_black_alpha(140));
        close = scrim.clicked() && scrim.interact_pointer_pos().is_some_and(|p| !panel.contains(p));
        let mut child = ui.new_child(egui::UiBuilder::new().max_rect(panel).layout(egui::Layout::top_down(egui::Align::Min)));
        child.set_clip_rect(panel);
        frame.show(&mut child, |ui| {
            ui.set_min_size(ui.available_size());
            add(ui);
        });
    });
    ctx.move_to_top(area.response.layer_id);
    close
}

impl App {
    /// Whether the sidebar is docked (as opposed to hidden or shown as a drawer).
    pub fn sidebar_docked(&self, ctx: &egui::Context) -> bool {
        self.sidebar_open && !self.sidebar_narrow(ctx)
    }

    /// Too narrow to dock the sidebar: a small window, or one where the right
    /// pane at its minimum would leave the chat less than its minimum width.
    pub fn sidebar_narrow(&self, ctx: &egui::Context) -> bool {
        let w = ctx.content_rect().width();
        let pane = self.pane(crate::surface::Dock::Right).open && self.surface_max.is_none();
        w < NARROW_W || (pane && w < SIDEBAR_W + 320.0 + CHAT_MIN_W)
    }

    /// Ctrl+\ and the sidebar buttons: dock or hide it, or on narrow windows
    /// open and close it as a drawer (without touching the docked preference).
    pub fn toggle_sidebar(&mut self, ctx: &egui::Context) {
        if self.sidebar_narrow(ctx) {
            self.sidebar_drawer = !self.sidebar_drawer;
        } else {
            self.sidebar_open = !self.sidebar_open;
            self.store.set("sidebar_open", if self.sidebar_open { "1" } else { "0" });
        }
    }

    /// Whether the team panel is showing, docked or as a drawer.
    pub fn team_showing(&self) -> bool {
        if self.team_docks { self.show_team } else { self.team_drawer }
    }

    pub fn toggle_team(&mut self) {
        if self.team_docks {
            self.show_team = !self.show_team;
            self.store.set("show_team", if self.show_team { "1" } else { "0" });
        } else {
            self.team_drawer = !self.team_drawer;
        }
    }

    /// Show the team panel (docked, or as a drawer when there's no room).
    pub fn open_team(&mut self) {
        if !self.team_showing() {
            self.toggle_team();
        }
    }

    /// "New thread (Ctrl+N)", with the action's current keys.
    pub fn key_hint(&self, text: &str, action: &str) -> String {
        format!("{text} ({})", crate::keys::label(&self.keys.get(action)))
    }

    /// Harbor's shortcuts, with the keys from Settings → Keybindings (see keys.rs).
    fn shortcuts(&mut self, ctx: &egui::Context) {
        if !matches!(self.view, View::Settings(Tab::Keybindings)) {
            self.keys.capture = None;
        }
        if self.keys.capture.is_some() {
            return;
        }
        let focused = ctx.memory(|m| m.focused());
        let term_has_focus = [crate::surface::Dock::Right, crate::surface::Dock::Bottom].iter().any(|d| focused == Some(crate::surface::term_id(*d)));
        // The image lightbox is modal too: its Esc closes it, not the running turn.
        let blocked = self.dialog.is_some() || crate::images::is_open(ctx);
        // Esc closes an open drawer first (and doesn't stop the turn).
        if (self.sidebar_drawer || self.team_drawer) && !blocked && self.popup.is_none() && ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, Key::Escape)) {
            self.sidebar_drawer = false;
            self.team_drawer = false;
        }
        let browser_focused = (0..2).any(|i| focused == Some(Id::NULL.with(("browser-page", i))));
        let k = &self.keys;
        let (new, esc, term, digit, sidebar, browser, settings) = ctx.input_mut(|i| {
            let digit = if term_has_focus || blocked {
                None
            } else {
                (1..=9u8).find(|n| Key::from_name(&n.to_string()).is_some_and(|k| i.consume_key(egui::Modifiers::COMMAND, k)))
            };
            (
                k.take(i, "new_thread"),
                !term_has_focus && !blocked && self.popup.is_none() && k.pressed(i, "stop_turn"),
                k.take(i, "toggle_terminal"),
                digit,
                k.take(i, "toggle_sidebar"),
                !browser_focused && k.take(i, "toggle_browser"),
                !blocked && k.take(i, "settings"),
            )
        });
        if sidebar {
            self.toggle_sidebar(ctx);
        }
        if browser {
            self.toggle_browser();
        }
        if settings {
            self.open(View::Settings(Tab::General));
        }
        if new {
            self.new_draft(None);
        }
        if esc {
            if let View::Chat(id) = self.view {
                self.esc(id, ctx);
            }
        }
        if term {
            self.toggle_terminal(ctx);
        }
        if let Some(n) = digit {
            if self.popup == Some(Popup::Model) {
                self.picker_pick_nth(n as usize - 1);
            } else if matches!(self.view, View::Chat(_) | View::Draft) {
                let s = self.sel();
                if let Some(kind) = self.account(&s.account).map(|a| a.kind) {
                    if let Some(m) = self.models_for(kind).iter().filter(|m| !m.more).nth(n as usize - 1).cloned() {
                        self.set_sel(Sel { model: m.id, ..s });
                    }
                }
            }
        }
    }
}

/// Repaints for a turn's events: at once while its chat is on screen, else one
/// coalesced frame per `agent::HIDDEN_WAKE`. The turn's end always shows (status,
/// notices), so it wakes at once.
pub fn turn_wake(ctx: &egui::Context, chat_id: i64) -> impl Fn(bool) + Send + Sync + 'static {
    let ctx = ctx.clone();
    move |ended: bool| {
        if ended || agent::SHOWN_CHAT.load(std::sync::atomic::Ordering::Relaxed) == chat_id {
            ctx.request_repaint();
        } else {
            ctx.request_repaint_after(agent::HIDDEN_WAKE);
        }
    }
}
