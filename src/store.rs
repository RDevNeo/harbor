//! SQLite persistence: repositories, chats and the items of each chat.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Repo {
    pub id: i64,
    pub path: PathBuf,
    pub name: String,
    /// Manual order in the sidebar.
    pub sort: i64,
    pub settled: bool,
}

/// What a chat is in a project's team.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The project's single thread: the lead agent that delegates.
    Lead,
    /// A worker spawned by the lead.
    Sub,
    /// A plain chat from earlier versions.
    Chat,
}

impl Role {
    fn parse(s: &str) -> Self {
        match s {
            "lead" => Role::Lead,
            "sub" => Role::Sub,
            _ => Role::Chat,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Role::Lead => "lead",
            Role::Sub => "sub",
            Role::Chat => "chat",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Timer {
    pub id: i64,
    pub chat_id: i64,
    pub at: i64,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct ProcRow {
    pub id: i64,
    pub lead: i64,
    pub repo_id: Option<i64>,
    pub owner: i64,
    pub name: String,
    pub cmd: String,
    pub cwd: String,
    pub pid: i64,
    /// Start time from /proc/<pid>/stat, so a reused pid isn't mistaken for ours.
    pub start_ticks: i64,
    pub log: String,
    pub url: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Webhook {
    pub id: i64,
    pub repo_id: i64,
    pub name: String,
    pub token: String,
    pub description: String,
    pub hits: i64,
    pub last_hit: i64,
}

#[derive(Clone, Debug)]
pub struct Chat {
    pub id: i64,
    /// None = "No project": runs in the home directory.
    pub repo_id: Option<i64>,
    pub title: String,
    /// Claude Code session id; set on creation and passed with `--resume` afterwards.
    pub session_id: String,
    /// True once the first turn has run, so later turns resume instead of creating.
    pub started: bool,
    /// Provider account id ("claude", "claude2", "codex", …).
    pub account: String,
    pub model: String,
    pub effort: String,
    /// "full", "edits", "plan" or "ask".
    pub access: String,
    pub settled: bool,
    pub updated: i64,
    pub role: Role,
    /// The lead of a subagent.
    pub parent: Option<i64>,
    /// Short handle agents use to address each other.
    pub name: String,
    /// The device its agent runs on (remote.rs `Host::id`); empty: this PC.
    pub device: String,
}

/// One rendered entry in a chat transcript.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    User {
        text: String,
        #[serde(default)]
        files: Vec<String>,
        /// Unix time; 0 for items saved before timestamps existed.
        #[serde(default)]
        at: i64,
        /// Messages mentioned with it (sent to the agent as quotes).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mentions: Vec<crate::mentions::Mention>,
    },
    Text {
        text: String,
        #[serde(default)]
        at: i64,
    },
    Thinking { text: String },
    Tool {
        id: String,
        name: String,
        #[serde(default)]
        summary: String,
        input: String,
        result: Option<String>,
        is_error: bool,
    },
    Result {
        cost_usd: f64,
        duration_ms: u64,
        turns: u64,
        input_tokens: u64,
        output_tokens: u64,
        #[serde(default)]
        at: i64,
        #[serde(default)]
        account: String,
        #[serde(default)]
        model: String,
    },
    Error { text: String },
    /// Something that happened to the team (wake-up, webhook, agent report).
    Notice {
        icon: String,
        text: String,
        #[serde(default)]
        detail: String,
    },
    /// A message between agents (or from the lead).
    Message { from: String, to: String, text: String },
}

pub struct Store {
    db: Connection,
    /// Per chat, a hash of each item as it is saved (by seq): a save writes only the
    /// items that changed, not the whole transcript.
    saved: RefCell<HashMap<i64, Vec<u64>>>,
}

/// FNV-1a of what is written into it: an item's JSON, hashed without building the string.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf29ce484222325)
    }
}

impl std::io::Write for Fnv {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        for x in b {
            self.0 = (self.0 ^ *x as u64).wrapping_mul(0x100000001b3);
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn item_hash(it: &Item) -> u64 {
    let mut h = Fnv::new();
    let _ = serde_json::to_writer(&mut h, it);
    h.0
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Harbor's data on this computer: harbor.db (chats, projects, and every setting in its
/// `kv` table) and the app sign-ins under `apps/`. Settings are local to this computer
/// and never sync or ship in a repo; when chats sync between PCs, settings still don't.
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/share"));
    base.join("harbor")
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| "/".into())
}

/// `n` bytes from the kernel's random source, for tokens and secrets: an error when it
/// can't be read, never a guessable fallback.
pub fn random_bytes(n: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut b = vec![0u8; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

/// [`random_bytes`] as `2n` hex digits.
pub fn random_hex(n: usize) -> std::io::Result<String> {
    Ok(random_bytes(n)?.iter().map(|x| format!("{x:02x}")).collect())
}

pub fn new_uuid() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/uuid")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| {
            // Fallback: time-based, still a valid v4-shaped uuid.
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let h = format!("{n:032x}");
            format!("{}-{}-4{}-a{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
        })
}

/// v1: chats get account/effort/access/settled and may have no project.
fn migrate(db: &Connection) -> rusqlite::Result<()> {
    let v: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        db.execute_batch(
            "PRAGMA foreign_keys=OFF;
             BEGIN;
             CREATE TABLE chats_v1(
                id INTEGER PRIMARY KEY,
                repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
                title TEXT NOT NULL, session_id TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0,
                account TEXT NOT NULL DEFAULT 'claude', model TEXT NOT NULL, effort TEXT NOT NULL DEFAULT '',
                access TEXT NOT NULL DEFAULT 'full', settled INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
             INSERT INTO chats_v1(id, repo_id, title, session_id, started, model, access, updated)
                SELECT id, repo_id, title, session_id, started,
                       CASE model WHEN 'opus' THEN 'claude-opus-5-5' WHEN 'sonnet' THEN 'claude-sonnet-5-5'
                                  WHEN 'haiku' THEN 'claude-haiku-5-5' ELSE model END,
                       CASE permission_mode WHEN 'acceptEdits' THEN 'edits' WHEN 'plan' THEN 'plan' ELSE 'full' END,
                       updated FROM chats;
             DROP TABLE chats;
             ALTER TABLE chats_v1 RENAME TO chats;
             PRAGMA user_version=1;
             COMMIT;
             PRAGMA foreign_keys=ON;",
        )?;
    }
    if v < 2 {
        db.execute_batch(
            "BEGIN;
             ALTER TABLE repos ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE repos ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE chats ADD COLUMN role TEXT NOT NULL DEFAULT 'chat';
             ALTER TABLE chats ADD COLUMN parent INTEGER;
             ALTER TABLE chats ADD COLUMN name TEXT NOT NULL DEFAULT '';
             CREATE TABLE timers(id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                at INTEGER NOT NULL, reason TEXT NOT NULL);
             CREATE TABLE webhooks(id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
                hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
             UPDATE repos SET sort = id;
             PRAGMA user_version=2;
             COMMIT;",
        )?;
    }
    if v < 3 {
        // Processes outlive Harbor; this is how they're found again after a restart.
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS procs(id INTEGER PRIMARY KEY, lead INTEGER NOT NULL, repo_id INTEGER,
                owner INTEGER NOT NULL, name TEXT NOT NULL, cmd TEXT NOT NULL, cwd TEXT NOT NULL,
                pid INTEGER NOT NULL, start_ticks INTEGER NOT NULL, log TEXT NOT NULL, url TEXT);
             PRAGMA user_version=3;",
        )?;
    }
    if v < 4 {
        // Timers are wake-ups ('wake') or continuations after a usage limit ('limit').
        db.execute_batch(
            "BEGIN;
             ALTER TABLE timers ADD COLUMN kind TEXT NOT NULL DEFAULT 'wake';
             PRAGMA user_version=4;
             COMMIT;",
        )?;
    }
    if v < 5 {
        // A chat's device: its agent runs there for the life of the chat.
        db.execute_batch(
            "BEGIN;
             ALTER TABLE chats ADD COLUMN device TEXT NOT NULL DEFAULT '';
             PRAGMA user_version=5;
             COMMIT;",
        )?;
    }
    Ok(())
}

impl Store {
    pub fn open() -> rusqlite::Result<Self> {
        let dir = data_dir();
        let _ = std::fs::create_dir_all(&dir);
        Self::open_at(&dir.join("harbor.db"))
    }

    fn open_at(path: &std::path::Path) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS repos(
                id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS chats(
                id INTEGER PRIMARY KEY,
                repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                title TEXT NOT NULL, session_id TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0,
                model TEXT NOT NULL, permission_mode TEXT NOT NULL, updated INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS items(
                chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(chat_id, seq));
             CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);",
        )?;
        migrate(&db)?;
        Ok(Self { db, saved: RefCell::default() })
    }

    pub fn repos(&self) -> Vec<Repo> {
        let mut st = self.db.prepare("SELECT id, path, name, sort, settled FROM repos ORDER BY sort, name COLLATE NOCASE").unwrap();
        st.query_map([], |r| {
            Ok(Repo {
                id: r.get(0)?,
                path: PathBuf::from(r.get::<_, String>(1)?),
                name: r.get(2)?,
                sort: r.get(3)?,
                settled: r.get::<_, i64>(4)? != 0,
            })
        })
        .unwrap()
        .flatten()
        .collect()
    }

    pub fn add_repo(&self, path: &std::path::Path) -> rusqlite::Result<i64> {
        let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        self.db.execute(
            "INSERT OR IGNORE INTO repos(path, name, sort) VALUES(?1, ?2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM repos))",
            params![path.to_string_lossy(), name],
        )?;
        self.db.query_row("SELECT id FROM repos WHERE path=?1", [path.to_string_lossy()], |r| r.get(0))
    }

    pub fn remove_repo(&self, id: i64) {
        let _ = self.db.execute("DELETE FROM repos WHERE id=?1", [id]);
        // Its chats went with it.
        self.saved.borrow_mut().clear();
    }

    pub fn save_repo_meta(&self, r: &Repo) {
        let _ = self.db.execute("UPDATE repos SET sort=?2, settled=?3 WHERE id=?1", params![r.id, r.sort, r.settled as i64]);
    }

    // ---- timers

    pub fn timers(&self) -> Vec<Timer> {
        let mut st = self.db.prepare("SELECT id, chat_id, at, reason FROM timers WHERE kind='wake' ORDER BY at").unwrap();
        st.query_map([], |r| Ok(Timer { id: r.get(0)?, chat_id: r.get(1)?, at: r.get(2)?, reason: r.get(3)? }))
            .unwrap()
            .flatten()
            .collect()
    }

    pub fn add_timer(&self, chat_id: i64, at: i64, reason: &str) -> i64 {
        let _ = self.db.execute("INSERT INTO timers(chat_id, at, reason) VALUES(?1, ?2, ?3)", params![chat_id, at, reason]);
        self.db.last_insert_rowid()
    }

    /// Continuations after a usage limit; `reason` holds their details (JSON).
    pub fn limit_timers(&self) -> Vec<Timer> {
        let mut st = self.db.prepare("SELECT id, chat_id, at, reason FROM timers WHERE kind='limit' ORDER BY at").unwrap();
        st.query_map([], |r| Ok(Timer { id: r.get(0)?, chat_id: r.get(1)?, at: r.get(2)?, reason: r.get(3)? }))
            .unwrap()
            .flatten()
            .collect()
    }

    pub fn add_limit_timer(&self, chat_id: i64, at: i64, reason: &str) -> i64 {
        let _ = self.db.execute("INSERT INTO timers(chat_id, at, reason, kind) VALUES(?1, ?2, ?3, 'limit')", params![chat_id, at, reason]);
        self.db.last_insert_rowid()
    }

    pub fn delete_timer(&self, id: i64) {
        let _ = self.db.execute("DELETE FROM timers WHERE id=?1", [id]);
    }

    // ---- processes

    pub fn procs(&self) -> Vec<ProcRow> {
        let mut st = self.db.prepare("SELECT id, lead, repo_id, owner, name, cmd, cwd, pid, start_ticks, log, url FROM procs").unwrap();
        st.query_map([], |r| {
            Ok(ProcRow {
                id: r.get(0)?,
                lead: r.get(1)?,
                repo_id: r.get(2)?,
                owner: r.get(3)?,
                name: r.get(4)?,
                cmd: r.get(5)?,
                cwd: r.get(6)?,
                pid: r.get(7)?,
                start_ticks: r.get(8)?,
                log: r.get(9)?,
                url: r.get(10)?,
            })
        })
        .unwrap()
        .flatten()
        .collect()
    }

    pub fn add_proc(&self, p: &ProcRow) -> i64 {
        let _ = self.db.execute(
            "INSERT INTO procs(lead, repo_id, owner, name, cmd, cwd, pid, start_ticks, log, url) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![p.lead, p.repo_id, p.owner, p.name, p.cmd, p.cwd, p.pid, p.start_ticks, p.log, p.url],
        );
        self.db.last_insert_rowid()
    }

    pub fn set_proc_url(&self, id: i64, url: &str) {
        let _ = self.db.execute("UPDATE procs SET url=?2 WHERE id=?1", params![id, url]);
    }

    pub fn delete_proc(&self, id: i64) {
        let _ = self.db.execute("DELETE FROM procs WHERE id=?1", [id]);
    }

    // ---- webhooks

    pub fn webhooks(&self) -> Vec<Webhook> {
        let mut st = self
            .db
            .prepare("SELECT id, repo_id, name, token, description, hits, last_hit FROM webhooks ORDER BY created")
            .unwrap();
        st.query_map([], |r| {
            Ok(Webhook {
                id: r.get(0)?,
                repo_id: r.get(1)?,
                name: r.get(2)?,
                token: r.get(3)?,
                description: r.get(4)?,
                hits: r.get(5)?,
                last_hit: r.get(6)?,
            })
        })
        .unwrap()
        .flatten()
        .collect()
    }

    pub fn add_webhook(&self, repo_id: i64, name: &str, token: &str, description: &str) {
        let _ = self.db.execute(
            "INSERT INTO webhooks(repo_id, name, token, description, created) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![repo_id, name, token, description, now()],
        );
    }

    pub fn hit_webhook(&self, id: i64) {
        let _ = self.db.execute("UPDATE webhooks SET hits = hits + 1, last_hit = ?2 WHERE id=?1", params![id, now()]);
    }

    pub fn delete_webhook(&self, id: i64) {
        let _ = self.db.execute("DELETE FROM webhooks WHERE id=?1", [id]);
    }

    pub fn chats(&self) -> Vec<Chat> {
        let mut st = self
            .db
            .prepare(
                "SELECT id, repo_id, title, session_id, started, account, model, effort, access, settled, updated, role, parent, name, device
                 FROM chats ORDER BY updated DESC",
            )
            .unwrap();
        st.query_map([], |r| {
            Ok(Chat {
                id: r.get(0)?,
                repo_id: r.get(1)?,
                title: r.get(2)?,
                session_id: r.get(3)?,
                started: r.get::<_, i64>(4)? != 0,
                account: r.get(5)?,
                model: r.get(6)?,
                effort: r.get(7)?,
                access: r.get(8)?,
                settled: r.get::<_, i64>(9)? != 0,
                updated: r.get(10)?,
                role: Role::parse(&r.get::<_, String>(11)?),
                parent: r.get(12)?,
                name: r.get(13)?,
                device: r.get(14)?,
            })
        })
        .unwrap()
        .flatten()
        .collect()
    }

    /// Inserts a chat built by the caller and returns it with its id.
    pub fn create_chat(&self, mut c: Chat) -> Chat {
        c.updated = now();
        self.db
            .execute(
                "INSERT INTO chats(repo_id, title, session_id, started, account, model, effort, access, settled, updated, role, parent, name, device)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![c.repo_id, c.title, c.session_id, c.started as i64, c.account, c.model, c.effort, c.access, c.settled as i64, c.updated,
                    c.role.as_str(), c.parent, c.name, c.device],
            )
            .unwrap();
        c.id = self.db.last_insert_rowid();
        c
    }

    pub fn save_chat(&self, c: &Chat) {
        let _ = self.db.execute(
            "UPDATE chats SET repo_id=?2, title=?3, session_id=?4, started=?5, account=?6, model=?7, effort=?8,
                access=?9, settled=?10, updated=?11, device=?12 WHERE id=?1",
            params![c.id, c.repo_id, c.title, c.session_id, c.started as i64, c.account, c.model, c.effort, c.access, c.settled as i64, c.updated, c.device],
        );
    }

    pub fn delete_chat(&self, id: i64) {
        let _ = self.db.execute("DELETE FROM chats WHERE id=?1", [id]);
        // Ids can be reused: a new chat with this one must not look saved.
        self.saved.borrow_mut().remove(&id);
    }

    pub fn items(&self, chat_id: i64) -> Vec<Item> {
        let mut st = self.db.prepare("SELECT body FROM items WHERE chat_id=?1 ORDER BY seq").unwrap();
        st.query_map([chat_id], |r| r.get::<_, String>(0))
            .unwrap()
            .flatten()
            .filter_map(|b| serde_json::from_str(&b).ok())
            .collect()
    }

    /// Saves a chat's transcript: only items that are new or changed since the last
    /// save are written, and items past its end are deleted.
    pub fn save_items(&mut self, chat_id: i64, items: &[Item]) {
        let hashes: Vec<u64> = items.iter().map(item_hash).collect();
        let saved = self.saved.get_mut().remove(&chat_id).unwrap_or_else(|| self.saved_hashes(chat_id));
        if saved == hashes {
            self.saved.get_mut().insert(chat_id, saved);
            return;
        }
        // On any failure the cache stays empty for the chat, so the next save compares
        // with what the database really has.
        let Ok(tx) = self.db.transaction() else { return };
        let mut ok = true;
        {
            let mut st = tx.prepare_cached("INSERT OR REPLACE INTO items(chat_id, seq, body) VALUES(?1, ?2, ?3)").unwrap();
            for (i, (it, h)) in items.iter().zip(&hashes).enumerate() {
                if saved.get(i) != Some(h) {
                    ok &= st.execute(params![chat_id, i as i64, serde_json::to_string(it).unwrap()]).is_ok();
                }
            }
        }
        if saved.len() > items.len() {
            ok &= tx.execute("DELETE FROM items WHERE chat_id=?1 AND seq>=?2", params![chat_id, items.len() as i64]).is_ok();
        }
        if ok && tx.commit().is_ok() {
            self.saved.get_mut().insert(chat_id, hashes);
        }
    }

    /// The hashes of a chat's items as the database has them, by seq.
    fn saved_hashes(&self, chat_id: i64) -> Vec<u64> {
        let mut v = vec![];
        let Ok(mut st) = self.db.prepare("SELECT seq, body FROM items WHERE chat_id=?1 ORDER BY seq") else { return v };
        let rows = st.query_map([chat_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)));
        for (seq, body) in rows.into_iter().flatten().flatten() {
            let Ok(seq) = usize::try_from(seq) else { continue };
            // A gap never matches an item, so the item there gets written.
            v.resize(seq, 0);
            let mut h = Fnv::new();
            let _ = h.write_all(body.as_bytes());
            v.push(h.0);
        }
        v
    }

    pub fn get(&self, k: &str) -> Option<String> {
        self.db.query_row("SELECT v FROM kv WHERE k=?1", [k], |r| r.get(0)).ok()
    }

    pub fn set(&self, k: &str, v: &str) {
        let _ = self.db.execute("INSERT OR REPLACE INTO kv(k, v) VALUES(?1, ?2)", [k, v]);
    }
}

/// Every chat's turn results, (chat id, item), read on a connection of its own so a
/// thread can sum them without the UI's store. Only result rows are parsed.
pub fn results() -> Vec<(i64, Item)> {
    let Ok(db) = Connection::open_with_flags(data_dir().join("harbor.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return vec![] };
    let Ok(mut st) = db.prepare(r#"SELECT chat_id, body FROM items WHERE body LIKE '{"kind":"result"%'"#) else { return vec![] };
    st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.flatten().filter_map(|(c, b)| Some((c, serde_json::from_str(&b).ok()?))).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Item {
        Item::Text { text: s.into(), at: 1 }
    }

    fn texts(store: &Store, chat: i64) -> Vec<String> {
        store.items(chat).into_iter().map(|it| if let Item::Text { text, .. } = it { text } else { String::new() }).collect()
    }

    #[test]
    fn saves_only_what_changed() {
        let dir = std::env::temp_dir().join(format!("harbor-store-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("harbor.db");
        let mut s = Store::open_at(&path).unwrap();
        let repo = s.add_repo(&dir).unwrap();
        let chat = |s: &Store| {
            s.create_chat(Chat {
                id: 0, repo_id: Some(repo), title: "t".into(), session_id: String::new(), started: false, account: "claude".into(),
                model: String::new(), effort: String::new(), access: "full".into(), settled: false, updated: 0, role: Role::Chat,
                parent: None, name: String::new(), device: String::new(),
            })
            .id
        };
        let a = chat(&s);
        let mut items: Vec<Item> = ["one", "two", "three"].map(text).to_vec();
        s.save_items(a, &items);
        assert_eq!(texts(&s, a), ["one", "two", "three"]);
        // A changed item in the middle, one appended.
        items[1] = text("TWO");
        items.push(text("four"));
        s.save_items(a, &items);
        assert_eq!(texts(&s, a), ["one", "TWO", "three", "four"]);
        // Shorter (undo): the rest goes, also for a store that hasn't saved this chat yet.
        let mut fresh = Store::open_at(&path).unwrap();
        fresh.save_items(a, &items[..2]);
        assert_eq!(texts(&fresh, a), ["one", "TWO"]);
        // A deleted chat's id, reused, doesn't count as saved.
        fresh.delete_chat(a);
        let b = chat(&fresh);
        fresh.save_items(b, &items[..1]);
        assert_eq!(texts(&fresh, b), ["one"]);
        drop((s, fresh));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
