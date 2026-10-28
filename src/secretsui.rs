use crate::app::App;
use crate::icons as ic;
use crate::secrets::{self as s, Ask, AskKind, Keep, Span};
use crate::store::{self, Chat, Role};
use crate::widgets::{self as w, Tip as _};
use eframe::egui::{self, Align, Frame, Key, Layout, Margin, RichText, Ui};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

fn names_arg(v: &Value) -> Vec<String> {
    match v {
        Value::Array(v) => v.iter().filter_map(|x| x.as_str()).filter_map(s::env_name).collect(),
        Value::String(t) => t.split([',', ' ']).filter_map(s::env_name).collect(),
        _ => vec![],
    }
}

fn text_arg(a: &Value, k: &str, max: usize) -> String {
    a[k].as_str().unwrap_or("").trim().chars().take(max).collect()
}

/// "BOAT_API_KEY", "A and B", "A, B and C".
fn and_list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// When a grant ends, for the agent.
fn span_words(span: Span) -> String {
    match span {
        Span::Minutes(m) => format!("for {} (until {})", s::minutes_label(m), crate::team::local_hm(store::now() + m as i64 * 60)),
        Span::Not => String::new(),
    }
}

impl App {
    /// Keys belong to this PC's person: not to a chat driven from another PC.
    fn secrets_guard(&self, me: &Chat) -> Result<(), String> {
        match self.guest_of(me) {
            Some(g) => Err(format!("secrets belong to this PC's person; this chat is driven from {}", g.name)),
            None => Ok(()),
        }
    }

    /// `list_secrets`: names, descriptions and what this chat may use now.
    pub fn list_secrets(&self, me: &Chat) -> String {
        let all = s::names();
        if all.is_empty() {
            return "No secrets saved on this PC. Ask for one with request_secret(name, reason, how_to_get).".into();
        }
        let now = store::now();
        let list: Vec<String> = all
            .iter()
            .map(|x| {
                let about = if x.description.is_empty() { String::new() } else { format!(": {}", x.description) };
                let access = match self.secrets.grants.iter().find(|g| g.chat == me.id && g.name == x.name && g.until > now) {
                    Some(g) => format!(" [you may use it until {}]", crate::team::local_hm(g.until)),
                    None => String::new(),
                };
                format!("- {}{about}{access}", x.name)
            })
            .collect();
        format!("{}\nUsing one needs the user's approval: request_secret_access(names, reason, minutes), then run_with_secrets.", list.join("\n"))
    }

    /// Puts `ask` in the chat (and its lead's), and tells the user's phone.
    fn post_ask(&mut self, me: &Chat, mut ask: Ask) -> Result<(), String> {
        let chats: Vec<i64> = self.chats.iter().map(|c| c.id).collect();
        self.secrets.asks.retain(|x| chats.contains(&x.chat));
        if self.secrets.asks.iter().any(|x| x.chat == me.id && x.kind == ask.kind && x.names == ask.names && x.env_file == ask.env_file) {
            return Err(format!("already asked for {}: wait for the [secret …] message", and_list(&ask.names)));
        }
        ask.id = store::new_uuid();
        ask.chat = me.id;
        ask.agent = if me.role == Role::Sub { me.name.clone() } else { "lead".into() };
        if !me.gid.is_empty() && !me.foreign() {
            let gid = me.parent.and_then(|p| self.chat(p)).map(|c| c.gid.clone()).unwrap_or_else(|| me.gid.clone());
            let what = match ask.kind {
                AskKind::Value => format!("asks for {}", and_list(&ask.names)),
                AskKind::Use => format!("wants to use {}", and_list(&ask.names)),
                AskKind::Env => format!("wants {} in {}", and_list(&ask.names), ask.env_file),
            };
            let body = if ask.reason.is_empty() { format!("Answer in Harbor on {}", crate::remote::hostname()) } else { ask.reason.clone() };
            crate::notify::post(&self.api.hub, "input", format!("secret:{gid}:{}", ask.id), format!("{} {what}", me.title), body, gid, false);
        }
        self.secrets.asks.push(ask);
        s::save_asks(&self.store, &self.secrets.asks);
        Ok(())
    }

    /// A .env file the agent named, checked before the user sees it.
    fn env_target(&self, me: &Chat, a: &Value, name: &str) -> Result<(String, String), String> {
        let file = text_arg(a, "env_file", 200);
        if file.is_empty() {
            return Ok((String::new(), String::new()));
        }
        s::env_path(&self.chat_cwd(me), &file)?;
        let var = match text_arg(a, "env_var", 64) {
            v if v.is_empty() => name.to_string(),
            v => s::env_var_name(&v).ok_or_else(|| format!("'{v}' isn't a variable name"))?,
        };
        Ok((file, var))
    }

    /// `request_secret`: a card where the user pastes the key; the answer comes later as a
    /// `[secret NAME]` message.
    pub fn request_secret(&mut self, me: &Chat, a: &Value) -> Result<String, String> {
        self.secrets_guard(me)?;
        let name = s::env_name(a["name"].as_str().unwrap_or("")).ok_or("name must be an environment variable name, like BOAT_API_KEY")?;
        let (env_file, env_var) = self.env_target(me, a, &name)?;
        let ask = Ask {
            kind: AskKind::Value,
            names: vec![name.clone()],
            reason: text_arg(a, "reason", 300),
            minutes: s::asked_minutes(&a["minutes"]),
            how_to_get: text_arg(a, "how_to_get", 600),
            env_file,
            env_var,
            ..Default::default()
        };
        self.post_ask(me, ask)?;
        let have = s::names().iter().any(|x| x.name == name);
        Ok(format!(
            "Asked the user for {name}{}. You'll get a [secret {name}] message when they answer; until then do other work or end your turn. Never ask for its value in the chat.",
            if have { " (one is saved already: they may replace it)" } else { "" }
        ))
    }

    /// `request_secret_access`: a card where the user lets this chat use saved keys for a while.
    pub fn request_secret_access(&mut self, me: &Chat, a: &Value) -> Result<String, String> {
        self.secrets_guard(me)?;
        let names = names_arg(&a["names"]);
        if names.is_empty() {
            return Err("names is empty: give the secrets you need, e.g. [\"BOAT_API_KEY\"]".into());
        }
        let saved = s::names();
        let missing: Vec<String> = names.iter().filter(|n| !saved.iter().any(|x| &x.name == *n)).cloned().collect();
        if !missing.is_empty() {
            return Err(format!("not saved on this PC: {}. Ask the user for it with request_secret(name, reason, how_to_get).", and_list(&missing)));
        }
        let reason = text_arg(a, "reason", 300);
        if reason.is_empty() {
            return Err("reason is empty: say what you need it for".into());
        }
        let minutes = s::asked_minutes(&a["minutes"]);
        self.post_ask(me, Ask { kind: AskKind::Use, names: names.clone(), reason, minutes, ..Default::default() })?;
        Ok(format!(
            "Asked the user to let you use {} for {}. You'll get a [secret …] message when they answer; until then do other work or end your turn.",
            and_list(&names),
            s::minutes_label(minutes)
        ))
    }

    /// `write_secret_to_env`: a card where the user lets Harbor write a saved key to a .env file.
    pub fn write_secret_to_env(&mut self, me: &Chat, a: &Value) -> Result<String, String> {
        self.secrets_guard(me)?;
        if me.access != "full" && me.access != "edits" {
            return Err("write_secret_to_env needs a chat that may edit files".into());
        }
        let name = s::env_name(a["name"].as_str().unwrap_or("")).ok_or("name must be a secret's name, like STRIPE_KEY")?;
        if !s::names().iter().any(|x| x.name == name) {
            return Err(format!("no secret named {name} on this PC. Ask for it with request_secret(name, reason, how_to_get, env_file)."));
        }
        let mut a = a.clone();
        a["env_file"] = a["file"].clone();
        a["env_var"] = a["var"].clone();
        let (env_file, env_var) = self.env_target(me, &a, &name)?;
        if env_file.is_empty() {
            return Err("file is empty: give a .env file, e.g. '.env.local'".into());
        }
        let ask = Ask { kind: AskKind::Env, names: vec![name.clone()], reason: text_arg(&a, "reason", 300), env_file: env_file.clone(), env_var, ..Default::default() };
        self.post_ask(me, ask)?;
        Ok(format!("Asked the user to write {name} to {env_file}. You'll get a [secret {name}] message when they answer."))
    }

    /// `run_with_secrets`, on a thread of its own: it answers when the command ends.
    pub fn run_with_secrets(&mut self, call: crate::control::ToolCall) {
        let reply = call.reply.clone();
        match self.secret_run(&call) {
            Ok((cmd, cwd, env, timeout)) => {
                std::thread::spawn(move || {
                    let _ = reply.send(match s::run(&cmd, &cwd, &env, timeout) {
                        Ok(t) => (true, t),
                        Err(e) => (false, e),
                    });
                });
            }
            Err(e) => {
                let _ = reply.send((false, e));
            }
        }
    }

    #[allow(clippy::type_complexity)]
    fn secret_run(&self, call: &crate::control::ToolCall) -> Result<(String, PathBuf, Vec<(String, String)>, Duration), String> {
        let me = self.chat(call.chat_id).cloned().ok_or("unknown agent")?;
        if me.role == Role::Chat {
            return Err("not part of a team".into());
        }
        if me.access != "full" {
            return Err(format!("run_with_secrets needs full access; this chat is {}", crate::providers::access_label(crate::providers::Kind::Claude, &me.access)));
        }
        self.secrets_guard(&me)?;
        let a = &call.args;
        let cmd = a["command"].as_str().unwrap_or("").trim().to_string();
        if cmd.is_empty() {
            return Err("command is empty".into());
        }
        let wanted = names_arg(&a["secrets"]);
        if wanted.is_empty() {
            return Err("secrets is empty: give the names to set, e.g. [\"BOAT_API_KEY\"]".into());
        }
        let all = s::load();
        let mut env = vec![];
        for n in &wanted {
            let x = all.iter().find(|x| &x.name == n).ok_or_else(|| format!("no secret named {n} on this PC. Ask the user for it with request_secret(name, reason, how_to_get)."))?;
            env.push((x.name.clone(), x.value.clone()));
        }
        let missing = s::ungranted(&self.secrets.grants, me.id, &wanted, store::now());
        if !missing.is_empty() {
            return Err(format!(
                "not allowed to use {} now. Ask with request_secret_access(names, reason, minutes) and wait for the [secret …] message.",
                and_list(&missing)
            ));
        }
        let base = self.chat_cwd(&me);
        let cwd = match a["cwd"].as_str().unwrap_or("").trim() {
            "" => base,
            c if c.starts_with('/') => PathBuf::from(c),
            c => base.join(c),
        };
        let timeout = a["timeout"].as_f64().unwrap_or(s::DEFAULT_TIMEOUT as f64).clamp(1.0, s::MAX_TIMEOUT as f64);
        Ok((cmd, cwd, env, Duration::from_secs_f64(timeout)))
    }

    fn tell(&mut self, chat: i64, notice: &str, prompt: String, auto: bool, ctx: &egui::Context) {
        self.notice(chat, "lock", notice, "");
        self.trigger(chat, prompt, auto, ctx);
    }

    fn grant(&mut self, chat: i64, names: &[String], span: Span) {
        s::grant(&mut self.secrets.grants, chat, names, span, store::now());
        s::save_grants(&self.store, &self.secrets.grants);
    }

    /// The user's answer to a card: `Some(card)` approves with its choices.
    fn answer(&mut self, ask: &Ask, card: Option<&s::Card>, ctx: &egui::Context) -> Result<(), String> {
        let list = and_list(&ask.names);
        let Some(card) = card else {
            let (notice, prompt) = match ask.kind {
                AskKind::Value => (format!("{list} not given"), format!("[secret {list}] The user said no. Go on without it, or say what it was for; never ask for it in the chat.")),
                AskKind::Use => (format!("Use of {list} not allowed"), format!("[secret {list}] The user didn't allow it. Go on without it, or ask again with a better reason if it's truly needed.")),
                AskKind::Env => (format!("{list} not written to {}", ask.env_file), format!("[secret {list}] The user didn't let Harbor write it to {}.", ask.env_file)),
            };
            self.close_ask(ask);
            self.tell(ask.chat, &notice, prompt, false, ctx);
            return Ok(());
        };
        let chat = self.chat(ask.chat).cloned().ok_or("the chat is gone")?;
        let spans = s::spans(ask.minutes);
        let span = match ask.kind {
            AskKind::Value => spans.get(card.span).copied().unwrap_or(Span::Not),
            _ => spans.get(card.span).copied().unwrap_or(Span::Minutes(ask.minutes)),
        };
        let name = ask.names.first().cloned().unwrap_or_default();
        let root = self.chat_cwd(&chat);
        let env_write = |value: &str| -> Result<(), String> {
            let path = s::env_path(&root, &ask.env_file)?;
            if card.add_ignore && card.ignored == Some(Some(false)) {
                s::add_to_gitignore(&root, &path)?;
            }
            s::write_env(&path, &ask.env_var, value)
        };
        let (notice, prompt) = match ask.kind {
            AskKind::Value => {
                let value = card.value.trim();
                if value.chars().count() < s::MIN_LEN {
                    return Err(format!("The value needs at least {} characters.", s::MIN_LEN));
                }
                let (harbor, file) = if ask.env_file.is_empty() { (true, false) } else { (card.keep != Keep::File, card.keep != Keep::Harbor) };
                if file {
                    env_write(value)?;
                }
                let mut said = vec![];
                if harbor {
                    s::save(&name, value, &ask.reason.chars().take(120).collect::<String>())?;
                    self.secrets.list = None;
                    said.push(match span {
                        Span::Not => "The user saved it in Harbor without giving you access: ask with request_secret_access when you need it.".to_string(),
                        _ => format!("The user saved it in Harbor and lets you use it {} with run_with_secrets: the command gets it as ${name}.", span_words(span)),
                    });
                    if span != Span::Not {
                        self.grant(ask.chat, &ask.names, span);
                    }
                }
                if file {
                    said.push(format!("Harbor wrote it to {} as {}.", ask.env_file, ask.env_var));
                }
                let notice = match (harbor, file) {
                    (true, true) => format!("{name} saved, and written to {}", ask.env_file),
                    (false, true) => format!("{name} written to {}", ask.env_file),
                    _ => format!("{name} saved as a secret"),
                };
                (notice, format!("[secret {name}] {}", said.join(" ")))
            }
            AskKind::Use => {
                self.grant(ask.chat, &ask.names, span);
                let shorter = match span {
                    Span::Minutes(m) if m < ask.minutes => format!(" (you asked for {})", s::minutes_label(ask.minutes)),
                    _ => String::new(),
                };
                (
                    format!("{list} allowed {}", span_words(span)),
                    format!("[secret {list}] The user lets you use it {}{shorter}: run_with_secrets(command, secrets).", span_words(span)),
                )
            }
            AskKind::Env => {
                let value = s::load().into_iter().find(|x| x.name == name).map(|x| x.value).ok_or_else(|| format!("{name} isn't saved any more"))?;
                env_write(&value)?;
                (format!("{name} written to {}", ask.env_file), format!("[secret {name}] Harbor wrote it to {} as {}.", ask.env_file, ask.env_var))
            }
        };
        self.close_ask(ask);
        self.tell(ask.chat, &notice, prompt, false, ctx);
        Ok(())
    }

    fn close_ask(&mut self, ask: &Ask) {
        self.secrets.asks.retain(|x| x.id != ask.id);
        self.secrets.cards.remove(&ask.id);
        s::save_asks(&self.store, &self.secrets.asks);
    }

    /// Ends the grants whose time is up and tells their chats; when the next one ends.
    pub fn expire_grants(&mut self, ctx: &egui::Context) -> Option<Duration> {
        let now = store::now();
        let gone = s::expire(&mut self.secrets.grants, now);
        if !gone.is_empty() {
            s::save_grants(&self.store, &self.secrets.grants);
        }
        for g in gone {
            if self.chat(g.chat).is_none() {
                continue;
            }
            self.tell(g.chat, &format!("{} access ended", g.name), format!("[secret {}] Your time to use it ended. Ask again with request_secret_access only if you still need it.", g.name), true, ctx);
        }
        self.secrets.grants.iter().map(|g| g.until).min().map(|t| Duration::from_secs((t - now).max(1) as u64))
    }

    fn revoke(&mut self, chat: i64, name: &str, ctx: &egui::Context) {
        self.secrets.grants.retain(|g| !(g.chat == chat && g.name == name));
        s::save_grants(&self.store, &self.secrets.grants);
        if self.chat(chat).is_some() {
            self.tell(chat, &format!("{name} access revoked"), format!("[secret {name}] The user revoked your access to it."), false, ctx);
        }
    }

    /// The cards of a chat and its sub-agents, then the keys they may use now.
    pub fn secret_asks_ui(&mut self, ui: &mut Ui, chat: i64) {
        let mine = |app: &App, c: i64| c == chat || app.chat(c).is_some_and(|x| x.parent == Some(chat));
        let asks: Vec<Ask> = self.secrets.asks.iter().filter(|x| mine(self, x.chat)).cloned().collect();
        for ask in asks {
            self.secret_card(ui, &ask);
        }
        let now = store::now();
        let grants: Vec<s::Grant> = self.secrets.grants.iter().filter(|g| g.until > now && mine(self, g.chat)).cloned().collect();
        if grants.is_empty() {
            return;
        }
        let t = self.theme.t;
        let mut revoke = None;
        for g in &grants {
            ui.horizontal(|ui| {
                ui.label(RichText::new(ic::LOCK).size(14.0).color(t.green(900)));
                let who = match self.chat(g.chat) {
                    Some(c) if c.id != chat => format!(" to {}", c.name),
                    _ => String::new(),
                };
                let left = format!("{} left", crate::team::until(g.until));
                w::subtle(ui, format!("{} allowed{who}  ·  {left}", g.name), "label-13");
                if w::btn("Revoke").xs().muted().show(ui).clicked() {
                    revoke = Some((g.chat, g.name.clone()));
                }
            });
        }
        ui.ctx().request_repaint_after(Duration::from_secs(30));
        if let Some((c, n)) = revoke {
            self.revoke(c, &n, ui.ctx());
        }
    }

    fn secret_card(&mut self, ui: &mut Ui, ask: &Ask) {
        let t = self.theme.t;
        let mut card = self.secrets.cards.remove(&ask.id).unwrap_or_default();
        let root = self.chat(ask.chat).map(|c| self.chat_cwd(c));
        let target = root.as_ref().filter(|_| !ask.env_file.is_empty()).and_then(|r| s::env_path(r, &ask.env_file).ok().map(|p| (r.clone(), p)));
        if card.ignored.is_none() {
            card.ignored = Some(target.as_ref().and_then(|(r, p)| s::git_ignored(r, p)));
            card.add_ignore = true;
        }
        let project = root.as_ref().and_then(|r| r.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let who = if ask.agent == "lead" { "The agent".to_string() } else { ask.agent.clone() };
        let list = and_list(&ask.names);
        let title = match ask.kind {
            AskKind::Value => format!("{who} asks for {list}"),
            AskKind::Use => format!("{who} wants to use {list} for {}", s::minutes_label(ask.minutes)),
            AskKind::Env => format!("{who} wants {list} written to {project}/{}", ask.env_file),
        };
        let have = ask.kind == AskKind::Value && s::names().iter().any(|x| ask.names.contains(&x.name));
        let spans = s::spans(ask.minutes);
        let mut act: Option<bool> = None;
        ui.add_space(4.0);
        w::card(ui).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(RichText::new(ic::LOCK).size(14.0).color(t.amber(900)));
                w::text(ui, &title, "strong-14");
            });
            if !ask.reason.is_empty() {
                w::subtle(ui, &ask.reason, "label-13");
            }
            if !ask.how_to_get.is_empty() {
                ui.add_space(4.0);
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    w::subtle(ui, "How to get it:", "label-13");
                    for word in ask.how_to_get.split_whitespace() {
                        let url = word.trim_end_matches(['.', ',', ')', ';']);
                        if url.starts_with("https://") || url.starts_with("http://") {
                            let r = ui.add(egui::Label::new(RichText::new(url).text_style(crate::theme::ts("label-13")).color(t.blue(900)).underline()).sense(egui::Sense::click()));
                            if r.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                                crate::git::open_url(url);
                            }
                            if url.len() < word.len() {
                                w::subtle(ui, &word[url.len()..], "label-13");
                            }
                        } else {
                            w::subtle(ui, word, "label-13");
                        }
                    }
                });
            }
            ui.add_space(6.0);
            if ask.kind == AskKind::Value {
                if !ask.env_file.is_empty() {
                    ui.horizontal(|ui| {
                        w::subtle(ui, "Keep it in", "label-13");
                        let file = format!("{} as {}", ask.env_file, ask.env_var);
                        let keeps = [Keep::Harbor, Keep::File, Keep::Both];
                        let cur = keeps.iter().position(|k| *k == card.keep).unwrap_or(0);
                        if let Some(i) = w::tabs(ui, &["Harbor", file.as_str(), "Both"], cur) {
                            card.keep = keeps[i];
                        }
                    });
                    ui.add_space(4.0);
                }
                let r = w::password(ui, &mut card.value, "Paste the value", ui.available_width());
                if r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) && card.value.trim().chars().count() >= s::MIN_LEN {
                    act = Some(true);
                }
                ui.add_space(4.0);
            }
            let in_harbor = ask.kind == AskKind::Use || (ask.kind == AskKind::Value && (ask.env_file.is_empty() || card.keep != Keep::File));
            if in_harbor {
                let mut labels: Vec<String> = spans.iter().map(|x| x.label(ask.minutes)).collect();
                if ask.kind == AskKind::Value {
                    labels.push(Span::Not.label(0));
                }
                let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
                ui.horizontal(|ui| {
                    w::subtle(ui, "Let it use it for", "label-13");
                    if let Some(i) = w::tabs(ui, &refs, card.span.min(refs.len() - 1)) {
                        card.span = i;
                    }
                });
                ui.add_space(4.0);
            }
            let to_file = ask.kind == AskKind::Env || (ask.kind == AskKind::Value && !ask.env_file.is_empty() && card.keep != Keep::Harbor);
            if to_file {
                match (&target, card.ignored) {
                    (None, _) => {
                        ui.label(RichText::new(format!("{}  {} can't be written: it isn't a .env file in the project.", ic::ALERT, ask.env_file)).text_style(crate::theme::ts("label-13")).color(t.red(900)));
                    }
                    (Some(_), Some(Some(false))) => {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(format!("{}  {} isn't in .gitignore: it could be committed.", ic::ALERT, ask.env_file)).text_style(crate::theme::ts("label-13")).color(t.amber(900)));
                            w::toggle(ui, &mut card.add_ignore);
                            w::subtle(ui, "Add it to .gitignore", "label-13");
                        });
                    }
                    _ => {}
                }
                w::subtle(ui, "A .env file is plain text: the agent's own tools can read it.", "label-12");
                ui.add_space(4.0);
            }
            ui.horizontal(|ui| {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if w::btn("Deny").sm().ghost().show(ui).clicked() {
                        act = Some(false);
                    }
                    let (label, ready) = match ask.kind {
                        AskKind::Value => ("Save", card.value.trim().chars().count() >= s::MIN_LEN && (!to_file || target.is_some())),
                        AskKind::Use => ("Allow", true),
                        AskKind::Env => ("Write", target.is_some()),
                    };
                    if w::btn(label).sm().primary().enabled(ready).show(ui).clicked() {
                        act = Some(true);
                    }
                    ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                        let note = match ask.kind {
                            AskKind::Value if have => "Kept on this PC, never in the chat. It replaces the one saved now.",
                            AskKind::Value => "Kept on this PC, never in the chat. The agent never sees it.",
                            AskKind::Use => "The agent runs commands with it set, and never sees it.",
                            AskKind::Env => "Harbor writes it; the agent isn't told the value.",
                        };
                        w::subtle(ui, note, "label-12");
                    });
                });
            });
        });
        match act {
            Some(ok) => {
                let r = self.answer(ask, ok.then_some(&card), ui.ctx());
                if let Err(e) = r {
                    crate::picker::show_toast(ui.ctx(), e);
                    self.secrets.cards.insert(ask.id.clone(), card);
                }
            }
            None => {
                self.secrets.cards.insert(ask.id.clone(), card);
            }
        }
    }

    /// Over the composer, while its text holds something shaped like a key: save it as a
    /// secret, and the message says its name instead.
    pub fn pasted_key_line(&mut self, ui: &mut Ui) {
        let key = self.key();
        let Some(text) = self.drafts.get(&key) else { return };
        let Some((found, guess)) = s::pasted_key(text).filter(|(k, _)| !self.secrets.ignored.iter().any(|x| x == k)) else { return };
        let found = found.to_string();
        let t = self.theme.t;
        let mut name = match self.secrets.paste_name.take() {
            Some((k, n)) if k == found => n,
            _ => guess.to_string(),
        };
        let (mut save_it, mut ignore) = (false, false);
        ui.horizontal(|ui| {
            ui.label(RichText::new(ic::LOCK).size(14.0).color(t.amber(900)));
            w::subtle(ui, "This looks like a key. Save it as a secret instead of sending it?", "label-13");
            w::input(ui, &mut name, "NAME", true, 170.0);
            save_it = w::btn("Save as secret").primary().xs().enabled(s::env_name(&name).is_some()).show(ui).clicked();
            ignore = w::btn("Send as is").xs().muted().show(ui).clicked();
        });
        ui.add_space(6.0);
        if ignore {
            self.secrets.ignored.push(found);
            return;
        }
        if !save_it {
            self.secrets.paste_name = Some((found, name));
            return;
        }
        match s::save(&name, &found, "") {
            Ok(n) => {
                self.secrets.list = None;
                if let Some(d) = self.drafts.get_mut(&key) {
                    *d = d.replace(&found, &format!("the secret {n} (saved in Harbor)"));
                }
            }
            Err(e) => crate::picker::show_toast(ui.ctx(), e),
        }
    }

    /// Settings › Secrets.
    pub fn secrets_tab(&mut self, ui: &mut Ui) {
        let list = self.secrets.list.get_or_insert_with(s::names).clone();
        crate::pages::section(ui, "Add a secret");
        let st = &mut self.secrets;
        let mut add = false;
        ui.horizontal(|ui| {
            let wd = (ui.available_width() - 8.0) / 2.0;
            w::input(ui, &mut st.name, "Name, like BOAT_API_KEY", true, wd);
            let r = w::password(ui, &mut st.value, "Value", wd);
            add |= r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
        });
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                add |= w::btn("Save").sm().primary().enabled(!st.name.trim().is_empty() && !st.value.trim().is_empty()).show(ui).clicked();
                ui.add_space(4.0);
                ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                    w::input(ui, &mut st.description, "What it's for (optional, agents see it)", false, ui.available_width());
                });
            });
        });
        if add {
            match s::save(&st.name, &st.value, &st.description) {
                Ok(_) => {
                    st.name.clear();
                    st.value.clear();
                    st.description.clear();
                    st.error = None;
                    st.list = None;
                }
                Err(e) => st.error = Some(e),
            }
        }
        if let Some(e) = &st.error {
            ui.add_space(4.0);
            ui.label(RichText::new(e).text_style(crate::theme::ts("label-13")).color(self.theme.t.red(900)));
        }
        self.grants_section(ui);
        crate::pages::section(ui, "Saved");
        let mut gone = None;
        let mut replaced = false;
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            if list.is_empty() {
                Frame::new().inner_margin(Margin::same(16)).show(ui, |ui| w::subtle(ui, "None yet. Add one above, or an agent asks for one when it needs it.", "label-13"));
            }
            for (i, x) in list.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            w::text(ui, &x.name, "label-13-mono");
                            let about = if x.description.is_empty() { "••••••••".to_string() } else { format!("••••••••  ·  {}", x.description) };
                            w::subtle(ui, format!("{about}  ·  {}", crate::app::ago(x.updated)), "label-12");
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if w::btn("Delete").sm().variant(w::Variant::GhostDestructive).show(ui).clicked() {
                                gone = Some(x.name.clone());
                            }
                            let open = self.secrets.replacing.as_ref().is_some_and(|(n, _)| n == &x.name);
                            if !open && w::btn("Replace").sm().ghost().show(ui).clicked() {
                                self.secrets.replacing = Some((x.name.clone(), String::new()));
                            }
                        });
                    });
                    let Some((n, v)) = self.secrets.replacing.as_mut().filter(|(n, _)| n == &x.name) else { return };
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if w::btn("Cancel").sm().ghost().show(ui).clicked() {
                                v.clear();
                                n.clear();
                            }
                            let mut go = w::btn("Save").sm().primary().enabled(v.trim().chars().count() >= s::MIN_LEN).show(ui).clicked();
                            ui.add_space(4.0);
                            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                                let r = w::password(ui, v, "New value", ui.available_width());
                                go |= r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) && v.trim().chars().count() >= s::MIN_LEN;
                            });
                            if go {
                                match s::save(n, v, "") {
                                    Ok(_) => replaced = true,
                                    Err(e) => crate::picker::show_toast(ui.ctx(), e),
                                }
                            }
                        });
                    });
                });
            }
        });
        if replaced || self.secrets.replacing.as_ref().is_some_and(|(n, _)| n.is_empty()) {
            self.secrets.replacing = None;
            self.secrets.list = None;
        }
        if let Some(n) = gone {
            if let Err(e) = s::delete(&n) {
                crate::picker::show_toast(ui.ctx(), e);
            }
            self.secrets.grants.retain(|g| g.name != n);
            s::save_grants(&self.store, &self.secrets.grants);
            self.secrets.list = None;
        }
        ui.add_space(12.0);
        w::subtle(
            ui,
            "Agents see only the names, and use a key only after you allow it, for the time you pick. Harbor's run_with_secrets tool runs their command on this PC with the key set and hides it in what comes back, as is and in common encodings (base64, URL, hex). That keeps keys out of chats by mistake; it is not a lock: a command that changes the value on purpose gets it through, and agents run as you, so one could read the file it's kept in. A key you let Harbor write to a project's .env file is plain text there, readable by the agent's own tools.",
            "label-12",
        );
        ui.add_space(4.0);
        w::subtle(ui, format!("Kept in {} (only you can read it), on this PC only: never synced to your other PCs or phones.", s::path().display()), "label-12");
    }

    /// Settings › Secrets › Allowed now: each chat's use of a key, with Revoke.
    fn grants_section(&mut self, ui: &mut Ui) {
        let now = store::now();
        let grants: Vec<s::Grant> = self.secrets.grants.iter().filter(|g| g.until > now).cloned().collect();
        if grants.is_empty() {
            return;
        }
        crate::pages::section(ui, "Allowed now");
        let mut revoke = None;
        w::card(ui).inner_margin(Margin::ZERO).show(ui, |ui| {
            ui.set_width(ui.available_width());
            for (i, g) in grants.iter().enumerate() {
                if i > 0 {
                    w::separator(ui);
                }
                Frame::new().inner_margin(Margin::symmetric(16, 10)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            w::text(ui, &g.name, "label-13-mono");
                            let chat = self.chat(g.chat).map(|c| if c.role == Role::Sub { format!("{} · {}", c.name, c.title) } else { c.title.clone() }).unwrap_or_default();
                            let left = format!("{} left", crate::team::until(g.until));
                            w::subtle(ui, format!("{chat}  ·  {left}"), "label-12");
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if w::btn("Revoke").sm().variant(w::Variant::GhostDestructive).show(ui).tip("It can't use the key from now on").clicked() {
                                revoke = Some((g.chat, g.name.clone()));
                            }
                        });
                    });
                });
            }
        });
        ui.ctx().request_repaint_after(Duration::from_secs(30));
        if let Some((c, n)) = revoke {
            self.revoke(c, &n, ui.ctx());
        }
    }
}
