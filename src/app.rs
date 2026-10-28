use crate::widgets::Tip as _;
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
/// rengaf's sidebar: 16rem.
pub const SIDEBAR_W: f32 = 256.0;
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
    Prs,
    Issues,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Tab {
    Account,
    General,
    Notifications,
    Appearance,
    Keybindings,
    Providers,
    Limits,
    Integrations,
    Webhooks,
    Devices,
    Phones,
    Voice,
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
    /// Which device the agent runs on.
    Device,
    /// Current checkout or a worktree (worktree.rs).
    Workspace,
    /// The branch picker under the composer.
    Branch,
}

pub enum Dialog {
    Rename { chat: i64, title: String },
    DeleteChat(i64),
    RemoveRepo(i64),
    /// Confirms stopping a lead and its running subagents.
    StopAll(i64),
    /// Instructions the user adds before a Fix / Merge agent starts.
    Instructions { project: i64, job: crate::autowork::Job, text: String },
    /// The keyboard shortcuts cheat sheet (`?`), with its filter.
    Shortcuts { query: String },
    /// A commit pill's card (commits.rs).
    Commit(Box<crate::commits::Card>),
}

pub enum Bg {
    Files(i64, Vec<PathBuf>),
    CursorModels(Vec<Model>),
    Prs(u64, crate::prs::StateF, Result<crate::prs::Fetched, String>),
    PrAvatar(String, Option<egui::ColorImage>),
    Issues(u64, crate::issues::StateF, Result<crate::issues::Fetched, String>),
    Funnel(Option<String>, Option<u16>),
    Avatar(i64, Option<egui::ColorImage>),
    GhRepos(Result<Vec<(String, String)>, String>),
    Cloned(Result<PathBuf, String>),
    Git(i64, Option<git::Status>),
    /// A shared project's clone is done (clone.rs): its folder, or why not.
    ProjectCloned(i64, Result<PathBuf, String>),
    /// The folder line's Clone here: the folder picked for a chat's project.
    ClonePicked(i64, PathBuf),
}

/// Account, model, effort and access of a chat or of the draft.
#[derive(Clone, PartialEq)]
pub struct Sel {
    pub account: String,
    pub model: String,
    pub effort: String,
    pub access: String,
    /// remote.rs `Host::id`; empty: this PC.
    pub device: String,
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

pub use crate::prs::Prs;

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
    /// When each loaded transcript was last shown or changed: idle ones are dropped
    /// from memory and loaded again from the store when needed.
    pub transcript_used: HashMap<i64, Instant>,
    last_sweep: Instant,
    pub drafts: HashMap<i64, String>,
    pub files: HashMap<i64, Vec<PathBuf>>,
    pub mentions: crate::mentions::State,
    pub slash: crate::slash::State,
    pub tags: crate::tags::State,
    /// The composer's `$` menu (chatmention.rs).
    pub chatm: crate::chatmention::State,
    pub palette: crate::palette::State,
    pub forks: crate::fork::State,
    pub turns: HashMap<i64, (agent::Turn, Instant)>,
    pub unread: HashSet<i64>,
    /// Unread chats whose last turn ended in an error (shown as Failed).
    pub failed: HashSet<i64>,
    /// Hidden until a time: "c<chat id>" / "r<project id>" → unix seconds.
    pub snoozed: HashMap<String, i64>,
    pub snooze_for: String,
    /// The snooze menu's custom time as typed ("5h", "18:00"); empty when it opens.
    pub snooze_text: String,
    pub add_project: Option<crate::addproject::AddProject>,
    /// Project icons: the project's website icon (None = none, use a monogram).
    pub avatars: HashMap<i64, Option<egui::TextureHandle>>,
    pub(crate) tx: Sender<(i64, Event)>,
    rx: Receiver<(i64, Event)>,
    pub bg_tx: Sender<Bg>,
    bg_rx: Receiver<Bg>,
    pub git: HashMap<i64, Option<git::Status>>,
    /// Projects whose git status is being read now, and those to read again after it.
    pub(crate) git_running: HashSet<i64>,
    git_again: HashSet<i64>,
    /// Wakes the UI from background threads (git status).
    pub(crate) ctx: egui::Context,
    pub collapsed: HashSet<i64>,
    pub expanded_tools: HashSet<(i64, usize)>,
    /// Runs of tool calls opened from their chevron row: (chat, the run's id, view.rs).
    pub open_tool_groups: HashSet<(i64, usize)>,
    pub md: CommonMarkCache,
    pub dialog: Option<Dialog>,
    pub popup: Option<Popup>,
    pub popup_anchor: egui::Rect,
    pub picker: Picker,
    pub prs: Prs,
    pub issues: crate::issues::Issues,
    pub auto: crate::autowork::State,
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
    pub recap: crate::recap::State,
    pub profile: crate::profile::State,
    /// Prompts waiting for a chat's current turn to end.
    pub pending: HashMap<i64, Vec<String>>,
    /// Shared projects being cloned here, and the turns waiting for them (clone.rs).
    pub clones: crate::clone::State,
    pub auto_turns: HashMap<i64, VecDeque<Instant>>,
    /// Projects whose automatic turns hit the hourly limit.
    pub paused: HashSet<i64>,
    pub timers: Vec<store::Timer>,
    pub webhooks: Vec<store::Webhook>,
    pub hook_tokens: Arc<Mutex<HashSet<String>>>,
    pub hook_port: Option<u16>,
    /// Public base of /hooks when Tailscale Funnel serves it.
    pub funnel: Option<String>,
    /// Funnel still sends /hooks to this other local port (not Harbor's now).
    pub funnel_stale: Option<u16>,
    inc_rx: Receiver<control::Incoming>,
    /// Where listeners hand work to the UI thread (the phone API starts later, from Settings).
    pub(crate) inc_tx: Sender<control::Incoming>,
    /// Settings › Phones: the API Harbor for Android talks to (api.rs).
    pub api: crate::api::Local,
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
    /// When the window was last touched, for an automatic update's quiet moment (reload.rs).
    pub reload_watch: crate::reload::Watch,
    /// The chat on screen is scrolled up, away from its end (chat.rs).
    pub reading_back: bool,
    /// The IME composition in progress, as its last pre-edit (see [`drop_idle_ime`]).
    ime_preedit: Option<egui::Event>,
    /// The Update button was clicked: reload as soon as the new version is on disk.
    pub reload_asked: bool,
    /// An Update from the phone or another PC: not before this, so its reply goes out first.
    pub reload_not_before: Option<std::time::Instant>,
    /// Long-running processes Harbor owns (dev servers, watchers, data pulls).
    pub procs: Vec<crate::procs::Proc>,
    pub proc_tx: Sender<crate::procs::ProcEvent>,
    proc_rx: Receiver<crate::procs::ProcEvent>,
    pub expanded_procs: HashSet<i64>,
    /// Processes that ended lately, (lead, name, how it ended, last output): process_logs
    /// and list_processes still answer for them after the process is gone.
    pub ended_procs: Vec<(i64, String, String, String)>,
    pub keys: crate::keys::Keys,
    /// Where Settings' Back goes: the view open before Settings.
    pub settings_back: View,
    /// Chats whose turn was cut off while Harbor was away (the runner died, as in a
    /// reboot): they continue when its replay ends, if `resume_on_restart` is on.
    pub cut_off: HashSet<i64>,
    /// Settings › Devices (remote.rs) and its page's state.
    pub remote: crate::remote::Config,
    pub devices_ui: crate::remoteui::State,
    /// The workspace and branch bar under the composer (worktree.rs).
    pub ws: crate::worktree::State,
    /// The composer's mic (voice.rs).
    pub voice: crate::voice::State,
    /// Settings › Usage totals, summed off the UI thread.
    pub usage_totals: crate::pages::UsageTotals,
    /// Where the message being sent was written, when not on this PC (another PC or a
    /// phone, see mesh.rs): set while such a call runs, stored on the message.
    pub sender: String,
    /// And its device id (a phone's "tok:…", another PC's "pc:…"), for the typing lock.
    pub sender_device: String,
    /// Copies of other PCs' chats and calls forwarded to them (mesh.rs).
    pub mesh: crate::mesh::Local,
    /// "Move to PC…": chats being handed to another PC or taken from one (movepc.rs).
    pub movepc: crate::movepc::Local,
    /// This PC's chats commanded from another PC: they run with its context (meshctx.rs).
    pub guests: HashMap<i64, crate::meshctx::Guest>,
}

impl App {
    pub fn new(ctx: &egui::Context) -> Self {
        let store = Store::open().expect("open database");
        let theme = Theme::new(Mode::parse(&store.get("theme").unwrap_or_default()));
        theme.apply(ctx);
        let (tx, rx) = channel();
        let (bg_tx, bg_rx) = channel();
        let (inc_tx, inc_rx) = channel();
        let guests = crate::meshctx::load_guests(&store);
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
            device: get("default_device", ""),
        };
        let favorites = get("favorites", "")
            .split(',')
            .filter_map(|x| x.split_once('|'))
            .map(|(a, m)| (a.to_string(), m.to_string()))
            .collect();
        let collapsed = get("collapsed", "").split(',').filter_map(|x| x.parse().ok()).collect();
        let draft = Draft { repo: get("draft_repo", "").parse().ok(), sel };
        let store_ref = &store;
        let api = crate::api::Local::new(Arc::new(crate::api::Hub::new(
            crate::api::load_tokens(store_ref),
            store_ref.get("api_port").and_then(|p| p.parse().ok()).unwrap_or(crate::api::DEFAULT_PORT),
        )));
        let _ = crate::api::HUB.set(api.hub.clone());
        api.hub.load_remembered(store_ref);
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
            transcript_used: HashMap::new(),
            last_sweep: Instant::now(),
            drafts: HashMap::new(),
            files: HashMap::new(),
            mentions: Default::default(),
            slash: Default::default(),
            tags: Default::default(),
            chatm: Default::default(),
            palette: Default::default(),
            forks: Default::default(),
            turns: HashMap::new(),
            unread: HashSet::new(),
            failed: HashSet::new(),
            snoozed: HashMap::new(),
            snooze_for: String::new(),
            snooze_text: String::new(),
            add_project: None,
            avatars: HashMap::new(),
            tx,
            rx,
            bg_tx,
            bg_rx,
            git: HashMap::new(),
            git_running: HashSet::new(),
            git_again: HashSet::new(),
            ctx: ctx.clone(),
            collapsed,
            expanded_tools: HashSet::new(),
            open_tool_groups: HashSet::new(),
            md: CommonMarkCache::default(),
            dialog: None,
            popup: None,
            popup_anchor: egui::Rect::NOTHING,
            picker: Picker::default(),
            prs: Prs::default(),
            issues: Default::default(),
            auto: Default::default(),
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
            recap: Default::default(),
            profile: Default::default(),
            pending: HashMap::new(),
            clones: Default::default(),
            auto_turns: HashMap::new(),
            paused: HashSet::new(),
            timers: vec![],
            webhooks: vec![],
            hook_tokens: Arc::new(Mutex::new(HashSet::new())),
            hook_port: None,
            funnel: None,
            funnel_stale: None,
            inc_rx,
            inc_tx: inc_tx.clone(),
            api,
            order_by_activity: false,
            fast: false,
            show_team: true,
            sidebar_open: true,
            sidebar_drawer: false,
            team_drawer: false,
            team_docks: true,
            update_ready: crate::reload::new_flag(),
            reload_watch: crate::reload::Watch::default(),
            reading_back: false,
            ime_preedit: None,
            reload_asked: false,
            reload_not_before: None,
            procs: vec![],
            proc_tx,
            proc_rx,
            expanded_procs: HashSet::new(),
            ended_procs: vec![],
            keys: Default::default(),
            settings_back: View::Draft,
            cut_off: HashSet::new(),
            remote: Default::default(),
            devices_ui: Default::default(),
            ws: Default::default(),
            voice: Default::default(),
            usage_totals: Default::default(),
            sender: String::new(),
            sender_device: String::new(),
            guests,
            mesh: Default::default(),
            movepc: Default::default(),
        };
        app.keys = crate::keys::Keys::load(&app.store);
        app.remote = crate::remote::load(&app.store);
        // Devices that were Tailscale peers move onto plain ssh, their chats with them.
        let moved = crate::remote::migrate_here(&mut app.remote, &crate::mesh::load_allowed(&app.store));
        if !moved.is_empty() {
            crate::remote::save(&app.store, &app.remote);
            for c in app.chats.iter_mut().filter(|c| !c.foreign()) {
                if let Some((_, to)) = moved.iter().find(|(from, _)| *from == c.device) {
                    c.device = to.clone();
                    app.store.save_chat(c);
                }
            }
        }
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
        // Public HTTPS for /hooks (hookcert.rs): a thread that does nothing until it's turned on.
        crate::hookcert::start(app.hook_tokens.clone(), inc_tx.clone(), wake.clone());
        app.hook_port = control::start_hooks(inc_tx, app.hook_tokens.clone(), wake);
        app.check_funnel();
        // The account: who is signed in, this PC's workspace and its directory (account.rs).
        crate::account::start(&app.store, {
            let ctx = ctx.clone();
            move || ctx.request_repaint()
        });
        app.mesh_load();
        if app.store.get("api_enabled").as_deref() == Some("1") {
            app.api_set_enabled(true, ctx);
        }
        if app.store.get("mesh_enabled").as_deref() == Some("1") {
            app.mesh_set_enabled(true, ctx);
        }
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
        app.voice_load();
        crate::theme::set_compact(app.store.get("density").as_deref() == Some("compact"));
        app.load_cursor_models();
        app.load_snoozed();
        app
    }

    /// Development aid for screenshots: HARBOR_VIEW=draft|picker|settings|usage|prs|issues|terminal,
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
            "device" => {
                self.open(View::Draft);
                self.popup = Some(Popup::Device);
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
            "usage" | "limits" => self.open(View::Settings(Tab::Limits)),
            "prs" => self.open(View::Prs),
            "issues" => self.open(View::Issues),
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
                } else if let Some(id) = v.strip_prefix("chat:").and_then(|i| i.parse().ok()) {
                    self.open(View::Chat(id));
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

    /// Wakes whatever shows `chat` once a background lookup has its answer (commits.rs): this
    /// window and the phones (the chat's revision moves, so they fetch it again).
    pub fn chat_waker(&self, chat: i64) -> impl Fn() + Send + Clone + 'static {
        let (ctx, hub) = (self.ctx.clone(), self.api.hub.clone());
        move || {
            hub.touch(Some(chat), false);
            ctx.request_repaint();
        }
    }

    pub fn cwd_of(&self, repo: Option<i64>) -> PathBuf {
        repo.and_then(|r| self.repo(r)).map(|r| r.dir().to_path_buf()).unwrap_or_else(store::home)
    }

    /// Where the current view's agent works: the chat's worktree or project, the draft's project.
    pub fn cwd_here(&self) -> PathBuf {
        match self.view {
            View::Chat(id) => self.chat(id).map(|c| self.chat_cwd(c)).unwrap_or_else(|| self.cwd_of(self.current_repo())),
            _ => self.cwd_of(self.draft.repo),
        }
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
                .map(|c| Sel { account: c.account.clone(), model: c.model.clone(), effort: c.effort.clone(), access: c.access.clone(), device: c.device.clone() })
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
        for (k, v) in [("default_account", &s.account), ("default_model", &s.model), ("default_effort", &s.effort), ("default_access", &s.access), ("default_device", &s.device)] {
            self.store.set(k, v);
        }
        self.draft.sel = s.clone();
        if let View::Chat(id) = self.view {
            // Another PC's chat changes there (and comes back with its copy).
            if self.is_foreign(id) {
                self.mesh_patch(id, serde_json::json!({ "account": s.account, "model": s.model, "effort": s.effort, "access": s.access }));
                return;
            }
            if let Some(c) = self.chat_mut(id) {
                c.account = s.account;
                c.model = s.model;
                c.effort = s.effort;
                c.access = s.access;
                // The session lives on the device it started on.
                if !c.started {
                    c.device = s.device;
                }
                let c = c.clone();
                self.store.save_chat(&c);
            }
        }
    }

    /// A started chat can only switch within its provider (Claude accounts share sessions).
    pub fn locked_kind(&self) -> Option<Kind> {
        let View::Chat(id) = self.view else { return None };
        self.locked_kind_of(id)
    }

    /// [`Self::locked_kind`] for any chat (the phone API changes chats that aren't open).
    pub fn locked_kind_of(&self, id: i64) -> Option<Kind> {
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
            View::Prs => self.load_prs(),
            View::Issues => self.load_issues(),
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

    /// Reads a project's git status on a thread (it can take seconds in a big tree);
    /// the last one known shows meanwhile. A refresh asked during one runs once after it.
    pub fn refresh_git(&mut self, repo_id: i64) {
        let Some(path) = self.repo(repo_id).map(|r| r.dir().to_path_buf()) else { return };
        if !self.git_running.insert(repo_id) {
            self.git_again.insert(repo_id);
            return;
        }
        let (tx, ctx) = (self.bg_tx.clone(), self.ctx.clone());
        std::thread::spawn(move || {
            let _ = tx.send(Bg::Git(repo_id, git::status(&path)));
            ctx.request_repaint();
        });
    }

    /// A git status read on a thread: kept, and read again if asked meanwhile.
    fn git_loaded(&mut self, repo_id: i64, s: Option<git::Status>) {
        // Its remote, kept: other PCs of the mesh know the project by it (clone.rs).
        let origin = s.as_ref().and_then(|s| s.origin.clone());
        if let Some(o) = origin.filter(|o| self.repo(repo_id).is_some_and(|r| r.remote != *o)) {
            self.store.set_repo_remote(repo_id, &o);
            if let Some(r) = self.repos.iter_mut().find(|r| r.id == repo_id) {
                r.remote = o;
            }
        }
        self.git.insert(repo_id, s);
        self.git_running.remove(&repo_id);
        if self.git_again.remove(&repo_id) {
            self.refresh_git(repo_id);
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
        if self.view == View::Issues {
            self.load_issues();
        }
    }

    pub fn check_funnel(&self) {
        // Funnel is only an extra while Tailscale is installed.
        if crate::providers::which("tailscale").is_none() {
            return;
        }
        let port = self.hook_port.unwrap_or(control::HOOK_PORT);
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            let (base, stale) = control::funnel(port);
            let _ = tx.send(Bg::Funnel(base, stale));
        });
    }

    fn load_cursor_models(&self) {
        let Some(bin) = self.account("cursor").and_then(|a| a.bin.clone()) else { return };
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Bg::CursorModels(providers::cursor_models(&bin)));
        });
    }

    /// Web links clicked anywhere in Harbor (agent replies, notices) open in the
    /// built-in browser pane instead of the system browser.
    fn route_links(&mut self, ctx: &egui::Context) {
        let mut urls = vec![];
        let mut chats = vec![];
        ctx.output_mut(|o| {
            o.commands.retain(|c| match c {
                egui::OutputCommand::OpenUrl(u) if u.url.starts_with("http://") || u.url.starts_with("https://") => {
                    urls.push(u.url.clone());
                    false
                }
                // A chat link (chatlink.rs) opens that chat here, never the system's harbor:// handler.
                egui::OutputCommand::OpenUrl(u) if u.url.starts_with(crate::chatlink::SCHEME) => {
                    chats.push(u.url.clone());
                    false
                }
                _ => true,
            })
        });
        if let Some(url) = chats.pop() {
            if let Err(why) = self.open_link(&url) {
                crate::picker::show_toast(ctx, why);
            }
        }
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
            let files = crate::picker::pick(crate::picker::Opts { title: "Attach files", multiple: true, ..Default::default() });
            if !files.is_empty() {
                let _ = tx.send(Bg::Files(key, files));
            }
        });
    }

    // ------------------------------------------------------------ terminal

    pub fn login(&mut self, ctx: &egui::Context, account_id: &str) {
        let Some(a) = self.account(account_id).cloned() else { return };
        let cwd = store::home();
        if !a.installed() {
            let argv = vec!["bash".into(), "-lc".into(), a.kind.install_script()];
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
        if key == DRAFT && self.mesh_create(&text, &files) {
            // The Device picked is another PC's Harbor: the chat starts there.
            self.drafts.remove(&key);
            self.files.remove(&key);
            self.mentions.drafts.remove(&key);
            return;
        }
        // "New worktree" under the composer: made on a thread; the message goes once it's ready
        // (or back into the composer if it can't be made).
        if key == DRAFT {
            if let Some((repo_dir, base)) = self.ws_wants_worktree(self.draft.repo, &self.draft.sel.device.clone()) {
                self.drafts.remove(&key);
                self.files.remove(&key);
                self.mentions.drafts.remove(&key);
                let held = crate::worktree::Held { repo: self.draft.repo, text, files, mentions };
                self.ws_send_in_worktree(ctx, repo_dir, base, held);
                return;
            }
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
        self.send_to(chat_id, text, files, mentions, ctx);
        self.focus_composer = true;
    }

    /// A user message for an existing chat (the composer's, or the phone's): a new turn,
    /// or queued while one runs.
    pub fn send_to(&mut self, chat_id: i64, text: String, files: Vec<PathBuf>, mut mentions: Vec<crate::mentions::Mention>, ctx: &egui::Context) {
        // Steer or Queue if its turn runs (queue.rs): the caller says which; else it queues.
        let mode = self.queue.mode.unwrap_or(crate::queue::Mode::Queue);
        // Mentioned chats get their context here, where they were picked (chatmention.rs).
        self.fill_chat_mentions(&mut mentions);
        // Another PC's chat: its PC runs the turn.
        let forwarded = self.mesh_send(chat_id, &text, &files, &mentions);
        self.queue.mode = None;
        if forwarded {
            return;
        }
        // Sent: the shared draft empties in every composer.
        self.api.hub.clear_draft(chat_id);
        // Being handed to another PC (movepc.rs): it goes there, or here if the move fails.
        if self.moving_to(chat_id).is_some() {
            self.movepc.held.entry(chat_id).or_default().push((text, files, mentions));
            self.api_touch(chat_id);
            return;
        }
        // Whose instructions and memory its turns run with: the PC that sent it (meshctx.rs).
        self.ctx_adopt(chat_id);
        if let Some(p) = self.chat(chat_id).and_then(|c| c.repo_id) {
            self.paused.remove(&p);
        }
        // Busy: it steers the turn or waits for its end (queue.rs).
        if self.turns.contains_key(&chat_id) {
            self.follow_up(chat_id, text, files, mentions, mode, ctx);
            return;
        }
        // Someone on another device is typing in it (one sender at a time): it waits in the
        // queue and joins the transcript once delivered.
        if self.locked_for(chat_id, &self.sending_device()) {
            self.enqueue(chat_id, text, files, mentions);
            return;
        }
        // A message to an idle chat resumes a queue its Stop held: the queue follows it.
        self.queue_resume(chat_id);
        let device = self.sending_device();
        let tr = self.transcripts.entry(chat_id).or_default();
        if tr.items.is_empty() {
            tr.items = self.store.items(chat_id);
        }
        let item = tr.items.len();
        // The previous message came from elsewhere: this one's place is said too.
        let back = tr.items.iter().rev().find_map(|i| match i {
            Item::User { sender, .. } => Some(!sender.is_empty()),
            _ => None,
        });
        let from = crate::queue::sent_from(&self.sender, &device, back == Some(true));
        tr.items.push(Item::User {
            text: text.clone(),
            files: files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            at: store::now(),
            mentions: mentions.clone(),
            sender: self.sender.clone(),
            intent: String::new(),
        });
        // Mentioned messages go first, quoted; the transcript shows them as chips.
        let quoted = format!("{from}{}", crate::mentions::prompt(&mentions));
        // Anything queued for an idle chat goes first; a fork's context before all.
        let fork = self.take_fork_preamble(chat_id);
        let queued = self.pending.remove(&chat_id).filter(|q| !q.is_empty());
        let snap = self.undo_snapshot(chat_id, item, &text, &files, &mentions, queued.as_deref().unwrap_or_default());
        let said = self.slash_prompt(chat_id, &text);
        let prompt = match queued {
            Some(q) => format!("{fork}{}\n\n---\n\n{quoted}{said}", q.join("\n\n---\n\n")),
            // A slash command only runs at the start: what goes with it follows.
            None if said.starts_with('/') && !(fork.is_empty() && quoted.is_empty()) => format!("{said}\n\n{fork}{quoted}").trim_end().to_string(),
            None => format!("{fork}{quoted}{said}"),
        };
        self.start_turn(chat_id, prompt, files, ctx);
        self.undo_started(chat_id, snap);
    }

    /// Starts one agent turn for a chat (user message, report, wake-up, webhook…).
    pub fn start_turn(&mut self, chat_id: i64, prompt: String, files: Vec<PathBuf>, ctx: &egui::Context) {
        // Turns of another PC's chat run on that PC only.
        if self.is_foreign(chat_id) {
            return;
        }
        // One turn per chat. A runner still going for it, even one this Harbor lost
        // track of, holds the session: the prompt waits for that turn instead.
        if self.turns.contains_key(&chat_id) || self.moving_to(chat_id).is_some() || self.adopt_runner(chat_id, ctx) {
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
        let remote = match self.remote_spec(&chat, &account, ctx) {
            Ok(r) => r,
            Err(e) => {
                self.transcripts.get_mut(&chat_id).unwrap().items.push(Item::Error { text: e });
                self.persist(chat_id);
                return;
            }
        };
        // The agent's tools work in the project folder on this PC (all of them, or the
        // workspace ones of a device without its own files): it has to be here.
        if remote.as_ref().is_none_or(|r| r.workspace) {
            // A project another PC shares: this PC's clone of it, made now if need be (clone.rs).
            if self.missing_folder(&chat).is_some() && self.clone_for_turn(&chat, &prompt, &files) {
                self.persist(chat_id);
                return;
            }
            if let Some(e) = self.missing_folder(&chat) {
                self.transcripts.get_mut(&chat_id).unwrap().items.push(Item::Error { text: e });
                self.persist(chat_id);
                return;
            }
        }
        // Without the account's login here the device runs the turn as whoever signed in
        // there: said once per chat, not on every turn.
        if remote.as_ref().is_some_and(|r| r.token.is_none()) {
            let text = format!("{} isn't signed in on this PC, so the device runs this chat under its own Claude login.", account.short());
            let said = self.transcripts.get(&chat_id).is_some_and(|t| t.items.iter().any(|i| matches!(i, Item::Notice { text: t, .. } if *t == text)));
            if !said {
                self.notice(chat_id, "alert", &text, "Sign in to that account here (claude /login, or the account's profile) for the chat to run as it there.");
            }
        }
        // Claude resumes sessions of its folder only: a moved chat's is brought over (movechat.rs).
        let context = self.turn_context(&chat, remote.is_some());
        if remote.is_none() && account.kind == Kind::Claude && chat.started && !chat.session_id.is_empty() {
            // (Also from the profiles of chats commanded from other PCs: the session may have
            // been written there, or here while it's one of those now.)
            let dst = context.overlay.clone().or_else(|| account.config_dir.clone());
            let mut also = crate::meshctx::overlays();
            also.push(account.config_dir.clone().unwrap_or_else(crate::meshctx::profile));
            let _ = crate::movechat::ensure_session_in(&dst, &also, &chat.session_id, &self.chat_cwd(&chat));
        }
        let spec = agent::TurnSpec {
            chat_id,
            cwd: self.chat_cwd(&chat),
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
            remote,
            trusted: self.trusted(chat.repo_id),
            context,
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
        self.api_touch(chat_id);
        if let Some(c) = self.chat(chat_id).cloned() {
            self.store.save_chat(&c);
        }
        if let Some(t) = self.transcripts.get(&chat_id) {
            self.store.save_items(chat_id, &t.items);
            self.transcript_used.insert(chat_id, Instant::now());
        }
    }

    /// Now and then: transcripts not shown, not running and untouched for a while leave
    /// memory (saved first); every reader loads a missing one from the store again.
    fn drop_idle_transcripts(&mut self) {
        if self.last_sweep.elapsed() < TRANSCRIPT_SWEEP {
            return;
        }
        self.last_sweep = Instant::now();
        let shown = match self.view {
            View::Chat(id) => Some(id),
            _ => None,
        };
        let idle: Vec<i64> = self
            .transcripts
            .keys()
            .copied()
            .filter(|id| Some(*id) != shown && !self.turns.contains_key(id) && self.queued(*id).is_empty())
            .filter(|id| self.pending.get(id).is_none_or(|p| p.is_empty()))
            .filter(|id| self.transcript_used.get(id).is_none_or(|t| t.elapsed() > TRANSCRIPT_IDLE))
            .collect();
        for id in idle {
            if let Some(t) = self.transcripts.remove(&id) {
                self.store.save_items(id, &t.items);
            }
            self.transcript_used.remove(&id);
        }
        if let Some(id) = shown {
            self.transcript_used.insert(id, Instant::now());
        }
    }

    pub fn stop(&mut self, chat_id: i64) {
        if self.mesh_stop(chat_id) {
            return;
        }
        if let Some((t, _)) = self.turns.remove(&chat_id) {
            // Its queue waits for Resume (or the next message), in order (queue.rs).
            self.queue_stopped(chat_id);
            t.stop();
            if let Some(tr) = self.transcripts.get_mut(&chat_id) {
                tr.items.push(Item::Error { text: "Stopped.".into() });
            }
            self.persist(chat_id);
        }
    }

    /// The exit of a turn the chat no longer runs (it was stopped and a new one started
    /// meanwhile): dropped, the new turn goes on.
    fn stale_exit(&self, chat_id: i64, ev: &Event) -> bool {
        ev.is_stale_exit(self.turns.get(&chat_id).map(|(t, _)| t.dir()))
    }

    fn apply_event(&mut self, id: i64, ev: Event, ctx: &egui::Context) {
        self.api_touch(id);
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
                let input = clip_middle(input, TOOL_TEXT_MAX);
                let result = result.map(|r| clip_middle(r, TOOL_TEXT_MAX));
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
            Event::Result { cost_usd, duration_ms, turns, input_tokens, output_tokens, cached } => {
                tr.got_result = true;
                let duration_ms =
                    if duration_ms == 0 { started_at.map(|s| s.elapsed().as_millis() as u64).unwrap_or(0) } else { duration_ms };
                tr.items.push(Item::Result {
                    cost_usd: cost_usd.unwrap_or(0.0),
                    duration_ms,
                    turns,
                    input_tokens,
                    output_tokens,
                    cached,
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
            Event::Exited { ok, .. } => {
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
                // The reply, for a notification (notify.rs).
                let said = tr.items.iter().rev().find_map(|i| match i {
                    Item::Text { text, .. } => Some(text.clone()),
                    _ => None,
                });
                let visible = self.view == View::Chat(id) && ctx.input(|i| i.viewport().focused.unwrap_or(true));
                // Subagents work behind the lead: only the lead's replies notify, and only once
                // its subagents finished too (the last one's report wakes the lead again).
                let sub = self.chat(id).is_some_and(|c| c.role == store::Role::Sub);
                let team_busy = !failed && self.team_started(id).is_some();
                if !visible && !sub && !resumes && !team_busy {
                    self.unread.insert(id);
                    if failed {
                        self.failed.insert(id);
                    } else {
                        self.failed.remove(&id);
                    }
                }
                // Notifications (notify.rs): the lead once its team is done (asking you something
                // counts as needing you), sub-agents as their own kind (off unless asked for).
                if !resumes && !stopped && (sub || !team_busy) {
                    self.note_turn(id, sub, failed, said.as_deref().unwrap_or(""));
                }
                if let Some(c) = self.chat_mut(id) {
                    c.updated = store::now();
                }
                self.persist(id);
                if let Some(r) = self.chat(id).and_then(|c| c.repo_id) {
                    self.refresh_git(r);
                }
                self.ctx_after_turn(id);
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
            let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h << 4 | l);
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

/// Tool inputs and outputs beyond this keep their start and end (the transcript is
/// kept in memory and saved, and nobody reads megabytes of output in it).
pub const TOOL_TEXT_MAX: usize = 64 * 1024;
/// How often idle transcripts are looked for, and how long one stays loaded unused.
const TRANSCRIPT_SWEEP: Duration = Duration::from_secs(60);
const TRANSCRIPT_IDLE: Duration = Duration::from_secs(15 * 60);

/// `s` cut to about `n` bytes: its first two thirds and its last third, with a marker
/// saying how much was left out in between.
pub fn clip_middle(s: String, n: usize) -> String {
    if s.len() <= n {
        return s;
    }
    let floor = |mut i: usize| {
        while !s.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let head = floor(n * 2 / 3);
    let tail = floor(s.len() - n / 3);
    format!("{}\n\n… ({} bytes cut) …\n\n{}", &s[..head], tail - head, &s[tail..])
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
    /// Development aid for headless screenshots: HARBOR_POINTER=x,y[,click|rclick|down|up|wheel[,secs]]
    /// places the pointer there and optionally clicks once after `secs` (default 1, fractions ok; `down`
    /// then `up` at another step drags, e.g. to select text); more
    /// steps joined by ';' follow at their own `secs` (since start).
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        // A keybinding being set takes every key first: no clipboard key, shortcut or text field sees it.
        if self.keys.capture.is_some() && matches!(self.view, View::Settings(Tab::Keybindings)) {
            self.keys.capture_raw(raw, &self.store);
        }
        let focused = ctx.memory(|m| m.focused());
        let in_terminal = [crate::surface::Dock::Right, crate::surface::Dock::Bottom].iter().any(|d| focused == Some(crate::surface::term_id(*d)));
        // Browser pages copy their own selection on Ctrl+C/X.
        let keep_copy_keys = (0..2usize).any(|i| focused == Some(Id::NULL.with(("browser-page", i))));
        crate::clipboard::shortcuts(raw, in_terminal, keep_copy_keys);
        drop_idle_ime(raw, &mut self.ime_preedit);
        self.paste_attachments(ctx, raw);
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        static DONE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let Ok(spec) = std::env::var("HARBOR_POINTER") else { return };
        let start = START.get_or_init(Instant::now);
        // Steps "x,y[,action[,secs]]" joined by ';': the pointer moves to each at its time.
        let steps: Vec<(egui::Pos2, &str, f64)> = spec
            .split(';')
            .filter_map(|s| {
                let parts: Vec<&str> = s.split(',').collect();
                let (x, y) = (parts.first()?.trim().parse().ok()?, parts.get(1)?.trim().parse().ok()?);
                Some((egui::pos2(x, y), parts.get(2).copied().unwrap_or(""), parts.get(3).and_then(|v| v.parse().ok()).unwrap_or(1.0)))
            })
            .collect();
        let Some(first) = steps.first() else { return };
        let due = steps.iter().take_while(|s| start.elapsed() > Duration::from_secs_f64(s.2)).count();
        let pos = steps.get(due.max(1) - 1).map_or(first.0, |s| s.0);
        raw.events.push(egui::Event::PointerMoved(pos));
        let done = DONE.load(std::sync::atomic::Ordering::Relaxed);
        if due > done {
            DONE.store(due, std::sync::atomic::Ordering::Relaxed);
            let (pos, action, _) = steps[due - 1];
            match action {
                "wheel" => raw.events.push(egui::Event::MouseWheel { unit: egui::MouseWheelUnit::Point, delta: egui::vec2(0.0, -400.0), phase: egui::TouchPhase::Move, modifiers: Default::default(), source: egui::MouseWheelSource::Wheel }),
                "click" | "rclick" => {
                    let button = if action == "click" { egui::PointerButton::Primary } else { egui::PointerButton::Secondary };
                    for pressed in [true, false] {
                        raw.events.push(egui::Event::PointerButton { pos, button, pressed, modifiers: Default::default() });
                    }
                }
                "down" | "up" => raw.events.push(egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed: action == "down", modifiers: Default::default() }),
                _ => {}
            }
        }
        // Later steps come on their own, without other input.
        if steps.len() > due {
            ctx.request_repaint_after(Duration::from_millis(50));
        }
    }

    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.tick(ctx);
    }

    fn ui(&mut self, ui: &mut Ui, frame: &mut eframe::Frame) {
        self.draw(ui, frame);
    }
}

impl App {
    /// Everything but drawing: also runs with no window (background.rs).
    pub fn tick(&mut self, ctx: &egui::Context) {
        self.auto_tick(ctx);
        self.drop_idle_transcripts();
        while let Ok((id, ev)) = self.rx.try_recv() {
            if self.undo_swallows(id, &ev) || self.stale_exit(id, &ev) || self.queue_event(id, &ev) || self.limit_event(id, &ev) {
                continue;
            }
            // A turn ends as a stop when it was already taken off `turns`.
            let exited = matches!(ev, Event::Exited { .. }).then(|| !self.turns.contains_key(&id));
            self.apply_event(id, ev, ctx);
            if let Some(stopped) = exited {
                self.queue_exited(id, stopped, ctx);
                self.limit_exited(id, ctx);
                self.restart_exited(id, ctx);
                self.recap_exited(id, stopped, ctx);
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
                Bg::Funnel(f, stale) => {
                    self.funnel = f;
                    self.funnel_stale = stale;
                }
                Bg::Git(repo, s) => self.git_loaded(repo, s),
                Bg::ProjectCloned(repo, r) => self.project_cloned(repo, r, ctx),
                Bg::ClonePicked(chat, p) => {
                    if let Err(e) = self.clone_here(chat, p) {
                        crate::picker::show_toast(ctx, e);
                    }
                }
                Bg::Prs(generation, state, r) => self.prs_loaded(generation, state, r),
                Bg::PrAvatar(login, img) => self.pr_avatar(ctx, login, img),
                Bg::Issues(generation, state, r) => self.issues_loaded(generation, state, r),
            }
        }
        while let Ok(e) = self.proc_rx.try_recv() {
            self.handle_proc_event(e, ctx);
        }
        while let Ok(m) = self.inc_rx.try_recv() {
            match m {
                control::Incoming::Tool(call) => self.handle_tool(call, ctx),
                control::Incoming::Hook(h) => self.handle_hook(h, ctx),
                control::Incoming::Api(call) => self.handle_api(call, ctx),
                control::Incoming::Mesh(m) => self.handle_mesh(m, ctx),
                control::Incoming::Focus { .. } if crate::background::hidden() => crate::background::show(ctx),
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
        // (With no window the input is the last window's: nothing was dropped.)
        if !dropped.is_empty() && !crate::background::hidden() && !crate::devices::claims_drop(ctx) {
            let key = self.key();
            self.files.entry(key).or_default().extend(dropped);
        }
        // Running turns don't tick the whole UI: spinners and counters ask for their
        // own next step while on screen (w::repaint_in), and agent events wake by chat.
        let hidden = ctx.input(|i| i.viewport().minimized == Some(true) || i.viewport().occluded == Some(true));
        let shown = match self.view {
            View::Chat(id) if !hidden => id,
            _ => 0,
        };
        agent::SHOWN_CHAT.store(shown, std::sync::atomic::Ordering::Relaxed);
        let focused = ctx.input(|i| i.viewport().focused.unwrap_or(true));
        agent::FOCUSED.store(focused && !hidden, std::sync::atomic::Ordering::Relaxed);
        self.notify_tick(ctx, focused && !hidden && !crate::background::hidden());
        self.wake_snoozed(ctx);
        self.mesh_tick(ctx);
        self.account_tick(ctx);
        self.ws_poll(ctx);
        self.voice_poll(ctx);
        self.queue_drain(ctx);
        self.queue_edit_check(ctx);
        self.recap_tick(ctx);
        self.api_tick();
        self.typing_repaint(ctx);
        self.maybe_reload(ctx);
        // The tray's Open while the window is up: bring it to the front.
        if crate::background::take_show() {
            ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
            ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
            if !crate::single::raise() {
                ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Critical));
            }
        }
    }

    fn draw(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.theme.refresh(&ctx);
        ctx.data_mut(|d| d.insert_temp(Id::NULL, TokensCell(self.theme.t)));
        self.shortcuts(&ctx);

        let t = self.theme.t;
        crate::picker::toast(&ctx, &t);
        // Every device signs in (account.rs): until then only the sign-in page.
        if crate::account::gate() {
            self.signin_page(ui);
            return;
        }
        self.update_toasts(&ctx);
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
                if crate::widgets::btn(crate::icons::PANEL_LEFT).muted().icon_xs().show(ui).tip(self.key_hint("Show sidebar", "toggle_sidebar")).clicked() {
                    self.toggle_sidebar(&ctx);
                }
            });
        }

        // Surface panes (browser, terminals, devices): right and/or bottom, or one maximized.
        use crate::surface::Dock;
        if let Some(d) = self.surface_max {
            if self.pane(d).open {
                egui::CentralPanel::default().frame(Frame::new().fill(t.bg200)).show(ui, |ui| self.pane_ui(ui, d));
                self.popups(&ctx);
                self.dialogs(&ctx);
                self.palette_ui(&ctx);
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
            View::Prs => self.prs_view(ui),
            View::Issues => self.issues_view(ui),
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
        self.palette_ui(&ctx);
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

    /// Ctrl+B and the sidebar buttons: dock or hide it, or on narrow windows
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
        let lead_open = matches!(self.view, View::Chat(id) if self.chat(id).is_some_and(|c| c.role == store::Role::Lead));
        let k = &self.keys;
        let (new, esc, term, digit, sidebar, team, browser, settings) = ctx.input_mut(|i| {
            let digit = if term_has_focus || blocked {
                None
            } else {
                (1..=9u8).find(|n| Key::from_name(&n.to_string()).is_some_and(|k| i.consume_key(egui::Modifiers::COMMAND, k)))
            };
            (
                k.take(i, "new_thread"),
                !term_has_focus && !blocked && self.popup.is_none() && self.slash.open.is_none() && !self.palette.open && k.pressed(i, "stop_turn"),
                k.take(i, "toggle_terminal"),
                digit,
                k.take(i, "toggle_sidebar"),
                // Ctrl+D in a terminal stays its EOF.
                lead_open && !term_has_focus && !blocked && k.take(i, "toggle_team"),
                !browser_focused && k.take(i, "toggle_browser"),
                !blocked && k.take(i, "settings"),
            )
        });
        if sidebar {
            self.toggle_sidebar(ctx);
        }
        if team {
            self.toggle_team();
        }
        // Ctrl+/ anywhere, or `?` with no text field focused: the cheat sheet.
        let sheet = ctx.input_mut(|i| self.keys.take(i, "shortcuts")) || (!ctx.egui_wants_keyboard_input() && ctx.input_mut(|i| self.keys.take(i, "shortcuts_q")));
        if !blocked && self.popup.is_none() && sheet {
            self.dialog = Some(Dialog::Shortcuts { query: String::new() });
        }
        if ctx.input_mut(|i| self.keys.take(i, "palette")) {
            self.palette_toggle();
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

/// Drops the IME events that change nothing: empty pre-edits and commits while
/// nothing is being composed, and a pre-edit repeated as is. On Wayland with an
/// input method (fcitx5, ibus), every `set_ime_cursor_area` is a text-input commit
/// that the compositor answers with `done`, which winit turns into a pre-edit
/// event (`Preedit("")` when idle); egui-winit sets the cursor area again on any
/// frame with input events, so a focused text field would repaint at the
/// monitor's refresh rate for as long as the window has focus. egui's TextEdit
/// ignores the empty ones outside a composition anyway.
fn drop_idle_ime(raw: &mut egui::RawInput, preedit: &mut Option<egui::Event>) {
    use egui::{Event, ImeEvent};
    raw.events.retain(|e| match e {
        Event::Ime(ImeEvent::Preedit { text, .. }) if text.is_empty() => preedit.take().is_some(),
        Event::Ime(ImeEvent::Preedit { .. }) => preedit.replace(e.clone()).as_ref() != Some(e),
        Event::Ime(ImeEvent::Commit(text)) => preedit.take().is_some() || !text.is_empty(),
        _ => true,
    });
}

/// Repaints for a turn's events: while its chat is on screen at most 20 fps (a
/// burst of streamed tokens is one frame), 4 fps while the window is unfocused,
/// else one coalesced frame per `agent::HIDDEN_WAKE`. The turn's end always shows
/// (status, notices) at once.
pub fn turn_wake(ctx: &egui::Context, chat_id: i64) -> impl Fn(bool) + Send + Sync + 'static {
    let ctx = ctx.clone();
    move |ended: bool| {
        if ended {
            ctx.request_repaint();
        } else if agent::SHOWN_CHAT.load(std::sync::atomic::Ordering::Relaxed) == chat_id {
            ctx.request_repaint_after(live_step(SHOWN_WAKE));
        } else {
            ctx.request_repaint_after(agent::HIDDEN_WAKE);
        }
    }
}

/// How soon the chat on screen repaints after one of its turn's events.
const SHOWN_WAKE: Duration = Duration::from_millis(50);

/// The step between frames of live output on screen: `focused` while the window has
/// focus, [`UNFOCUSED_WAKE`] at the least while it doesn't (each frame repaints the
/// whole window and makes the compositor redraw it).
pub fn live_step(focused: Duration) -> Duration {
    if agent::FOCUSED.load(std::sync::atomic::Ordering::Relaxed) { focused } else { focused.max(UNFOCUSED_WAKE) }
}

const UNFOCUSED_WAKE: Duration = Duration::from_millis(250);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_survives_non_ascii_after_percent() {
        assert_eq!(percent_decode("/tmp/%1\u{e9}"), "/tmp/%1\u{e9}");
        assert_eq!(percent_decode("/tmp/%\u{e9}x"), "/tmp/%\u{e9}x");
        assert_eq!(percent_decode("/tmp/a%20b%zz"), "/tmp/a b%zz");
        let _ = copied_files("file:///tmp/%1\u{e9}");
    }

    #[test]
    fn clips_the_middle_of_long_text() {
        assert_eq!(clip_middle("short".into(), 10), "short");
        let s = format!("{}{}", "a".repeat(600), "b".repeat(600));
        let c = clip_middle(s, 300);
        assert!(c.starts_with(&"a".repeat(200)) && c.ends_with(&"b".repeat(100)));
        assert!(c.contains("(900 bytes cut)"));
        // Never cuts inside a character.
        let c = clip_middle("é".repeat(1000), 101);
        assert!(c.starts_with('é') && c.ends_with('é'));
    }
}
