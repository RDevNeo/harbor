//! Agents that fix issues and merge pull requests: the "Fix with …" and
//! "Merge with …" buttons of the Issues and Pull requests pages, and the
//! Auto-Fix / Auto-Merge settings that start those threads by themselves.
//!
//! Each run is a new thread in the item's Harbor project (never in a repo that
//! isn't one). A lead runs on Claude; another provider picked in the dropdown
//! does the work as a subagent the lead spawns. Auto runs start once per issue
//! and once per PR head commit (remembered in the store), at most
//! [`MAX_AUTO`] at a time.

use crate::app::{App, Sel, View};
use crate::icons as ic;
use crate::issues::{self, Issue, IssueState};
use crate::providers::Kind;
use crate::prs::{self, Checks, Pr, PrState, Review};
use crate::store::{self, Item};
use crate::widgets as w;
use eframe::egui::{self, Ui};
use std::collections::HashSet;
use std::time::{Duration, Instant};

/// Auto threads running at once.
pub const MAX_AUTO: usize = 2;
/// How often the lists refresh in the background while an auto setting is on.
const REFRESH: Duration = Duration::from_secs(10 * 60);
/// How often the fetched lists are checked for work.
const TICK: Duration = Duration::from_secs(20);
/// Handled keys kept (oldest dropped).
const KEEP: usize = 500;

#[derive(Default)]
pub struct State {
    /// "issue <url>" and "pr <url>@<head>" already given to an agent.
    handled: Option<Vec<String>>,
    /// Lead chats started automatically.
    auto_chats: Vec<i64>,
    last_tick: Option<Instant>,
    last_refresh: Option<Instant>,
}

pub fn issue_key(i: &Issue) -> String {
    format!("issue {}", i.url)
}

pub fn pr_key(p: &Pr) -> String {
    format!("pr {}@{}", p.url, p.head)
}

/// The Harbor project whose GitHub repo is `repo` (owner/name).
pub fn project_of(projects: &[(i64, String, String)], repo: &str) -> Option<i64> {
    projects.iter().find(|p| p.2.eq_ignore_ascii_case(repo)).map(|p| p.0)
}

/// Issues Auto-Fix takes: open, assigned to the viewer, in a Harbor project,
/// with no open PR that fixes them, not handled before. Oldest update first.
pub fn issues_to_fix(data: &issues::Fetched, projects: &[(i64, String, String)], handled: &HashSet<String>) -> Vec<(i64, Issue)> {
    let me = data.viewer.as_str();
    let mut v: Vec<(i64, Issue)> = data
        .items
        .iter()
        .filter(|i| i.state == IssueState::Open && !i.linked_pr && !me.is_empty() && i.assignees.iter().any(|a| a.eq_ignore_ascii_case(me)))
        .filter(|i| !handled.contains(&issue_key(i)))
        .filter_map(|i| project_of(projects, &i.repo).map(|p| (p, i.clone())))
        .collect();
    v.sort_by_key(|x| x.1.updated);
    v
}

/// PRs Auto-Merge takes: the viewer's own, open, not drafts, checks passing
/// (or none), no changes requested, in a Harbor project, this head commit not
/// handled before.
pub fn prs_to_merge(data: &prs::Fetched, projects: &[(i64, String, String)], handled: &HashSet<String>) -> Vec<(i64, Pr)> {
    let me = data.viewer.as_str();
    let mut v: Vec<(i64, Pr)> = data
        .items
        .iter()
        .filter(|p| p.state == PrState::Open && !p.draft && !me.is_empty() && p.author.eq_ignore_ascii_case(me))
        .filter(|p| matches!(p.checks, Checks::Passing | Checks::None) && p.review != Review::Changes && !p.head.is_empty())
        .filter(|p| !handled.contains(&pr_key(p)))
        .filter_map(|p| project_of(projects, &p.repo).map(|id| (id, p.clone())))
        .collect();
    v.sort_by_key(|x| x.1.updated);
    v
}

pub fn fix_prompt(i: &Issue, auto: bool) -> String {
    let n = i.number;
    let pre = if auto { "(Started by Harbor's Auto-Fix.)\n\n" } else { "" };
    format!(
        "{pre}Fix GitHub issue #{n} in {}: {}\n{}\n\nRead it with `gh issue view {n} --comments` and find the cause. On a new branch `fix/issue-{n}` from the default branch, make the fix (with a test where it fits), commit, push the branch and open a pull request with `gh pr create` whose body says `Fixes #{n}`. Reply with the PR link and a short summary. If the issue is unclear or can't be fixed safely, don't guess: comment on it with what you found instead.",
        i.repo, i.title, i.url
    )
}

pub fn merge_prompt(p: &Pr, auto: bool) -> String {
    let n = p.number;
    let pre = if auto { "(Started by Harbor's Auto-Merge.)\n\n" } else { "" };
    format!(
        "{pre}Get pull request #{n} in {} merged: {}\n{}\n\nCheck it out with `gh pr checkout {n}`, rebase it on its base branch and resolve any conflicts, make the checks pass (`gh pr checks {n}`), and address the review comments (`gh pr view {n} --comments`). Push, and once it is mergeable merge it with `gh pr merge {n}`. If something can't be resolved safely, stop and explain why instead of merging.",
        p.repo, p.title, p.url
    )
}

impl App {
    fn handled(&mut self) -> &mut Vec<String> {
        let store = &self.store;
        self.auto.handled.get_or_insert_with(|| store.get("auto_handled").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
    }

    fn mark_handled(&mut self, key: String) {
        let h = self.handled();
        if !h.contains(&key) {
            h.push(key);
        }
        let n = h.len().saturating_sub(KEEP);
        h.drain(..n);
        let json = serde_json::to_string(&h).unwrap_or_default();
        self.store.set("auto_handled", &json);
    }

    pub fn auto_fix(&self) -> bool {
        self.store.get("auto_fix").as_deref() == Some("1")
    }

    pub fn auto_merge(&self) -> bool {
        self.store.get("auto_merge").as_deref() == Some("1")
    }

    /// The account fix and merge threads run with: the one picked in their
    /// dropdown, else the composer's.
    pub fn agent_account(&self) -> Option<crate::providers::Account> {
        let pick = self.store.get("gh_agent_account").filter(|id| self.account(id).is_some_and(|a| a.installed()));
        let id = pick.unwrap_or_else(|| self.draft.sel.account.clone());
        self.account(&id).or_else(|| self.accounts.iter().find(|a| a.kind == Kind::Claude)).cloned()
    }

    /// "Claude", or "Claude · IG" when there are several Claude accounts.
    pub fn agent_label(&self) -> String {
        let Some(a) = self.agent_account() else { return "an agent".into() };
        let same = self.accounts.iter().filter(|x| x.kind == a.kind && x.installed()).count();
        if same > 1 { a.short() } else { a.kind.label().into() }
    }

    /// Starts a thread in `project` that runs `prompt` with the agent account;
    /// opens it unless `quiet`. Returns the chat.
    fn launch(&mut self, ctx: &egui::Context, project: i64, prompt: String, quiet: bool) -> Option<i64> {
        let acc = self.agent_account()?;
        let mut sel: Sel = self.draft.sel.clone();
        let prompt = if acc.kind == Kind::Claude {
            if self.account(&sel.account).is_none_or(|a| a.kind != Kind::Claude) {
                sel.model = "claude-opus-5-5".into();
            }
            sel.account = acc.id.clone();
            prompt
        } else {
            format!("{prompt}\n\nDo the work through one subagent: spawn_agent with account `{}` ({}).", acc.id, acc.kind.label())
        };
        sel.device = String::new();
        if !quiet {
            // As when the user writes: their own run lifts a project's pause.
            self.paused.remove(&project);
        }
        let id = self.new_thread_with(Some(project), &prompt, sel);
        let tr = self.transcripts.entry(id).or_default();
        tr.items.push(Item::User { text: prompt.clone(), files: vec![], at: store::now(), mentions: vec![] });
        self.persist(id);
        self.start_turn(id, prompt, vec![], ctx);
        if !quiet {
            self.store.set("last_chat", &id.to_string());
            self.open(View::Chat(id));
        }
        Some(id)
    }

    pub fn fix_issue(&mut self, ctx: &egui::Context, project: i64, i: &Issue) {
        if self.launch(ctx, project, fix_prompt(i, false), false).is_some() {
            self.mark_handled(issue_key(i));
        }
    }

    pub fn merge_pr(&mut self, ctx: &egui::Context, project: i64, p: &Pr) {
        if self.launch(ctx, project, merge_prompt(p, false), false).is_some() {
            if !p.head.is_empty() {
                self.mark_handled(pr_key(p));
            }
        }
    }

    /// A primary "<verb> with <provider>" button and a ▾ to pick the provider.
    /// Disabled with `tip` when `enabled` is false. True when clicked.
    pub fn agent_button(&mut self, ui: &mut Ui, verb: &str, enabled: bool, tip: &str) -> bool {
        let label = format!("{}  {verb} with {}", ic::SPARKLES, self.agent_label());
        let mut clicked = false;
        ui.scope(|ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            // Right-to-left layouts: the ▾ goes first so it lands on the right.
            let more = w::btn(ic::DOWN).sm().primary().show(ui).on_hover_text("Pick the provider");
            let cur = self.agent_account().map(|a| a.id);
            let accounts: Vec<_> = self.accounts.iter().filter(|a| a.installed()).cloned().collect();
            let mut pick = None;
            egui::Popup::menu(&more).show(|ui| {
                ui.set_min_width(200.0);
                for a in &accounts {
                    let mark = if cur.as_deref() == Some(a.id.as_str()) { ic::CHECK } else { " " };
                    if ui.button(format!("{mark}  {}", a.short())).clicked() {
                        pick = Some(a.id.clone());
                    }
                }
            });
            if let Some(id) = pick {
                self.store.set("gh_agent_account", &id);
            }
            clicked = w::btn(&label).sm().primary().enabled(enabled).show(ui).on_hover_text(tip).on_disabled_hover_text(tip).clicked();
        });
        clicked
    }

    // ------------------------------------------------------------ auto

    /// Auto threads still working (their lead or a subagent has a turn running).
    fn auto_running(&mut self) -> usize {
        let turns = &self.turns;
        let chats = &self.chats;
        self.auto.auto_chats.retain(|id| turns.contains_key(id) || chats.iter().any(|c| c.parent == Some(*id) && turns.contains_key(&c.id)));
        self.auto.auto_chats.len()
    }

    /// Every frame: with Auto-Fix / Auto-Merge on, refresh the lists now and
    /// then and start threads for what they find, a few at a time.
    pub fn auto_tick(&mut self, ctx: &egui::Context) {
        let (fix, merge) = (self.auto_fix(), self.auto_merge());
        if !fix && !merge {
            return;
        }
        if self.auto.last_tick.is_some_and(|t| t.elapsed() < TICK) {
            return;
        }
        self.auto.last_tick = Some(Instant::now());
        // Idle windows draw no frames: wake for the next check.
        ctx.request_repaint_after(TICK);
        if self.prs.ctx.is_none() {
            self.prs.ctx = Some(ctx.clone());
        }
        if self.auto.last_refresh.is_none_or(|t| t.elapsed() > REFRESH) {
            self.auto.last_refresh = Some(Instant::now());
            if fix && !self.issues.loading {
                self.load_issues();
            }
            if merge && !self.prs.loading {
                self.load_prs();
            }
            return;
        }
        // Never in a project whose automatic turns hit the hourly limit.
        let paused = self.paused.clone();
        let projects: Vec<_> = self.pr_projects().into_iter().filter(|p| !paused.contains(&p.0)).collect();
        let handled: HashSet<String> = self.handled().iter().cloned().collect();
        let mut room = MAX_AUTO.saturating_sub(self.auto_running());
        if fix && room > 0 {
            let data = self.issues.data.as_ref().and_then(|d| d.as_ref().ok()).cloned();
            for (project, i) in data.map(|d| issues_to_fix(&d, &projects, &handled)).unwrap_or_default().into_iter().take(room) {
                self.mark_handled(issue_key(&i));
                if let Some(id) = self.launch(ctx, project, fix_prompt(&i, true), true) {
                    self.auto.auto_chats.push(id);
                    room -= 1;
                }
            }
        }
        if merge && room > 0 {
            let data = self.prs.data.as_ref().and_then(|d| d.as_ref().ok()).cloned();
            for (project, p) in data.map(|d| prs_to_merge(&d, &projects, &handled)).unwrap_or_default().into_iter().take(room) {
                self.mark_handled(pr_key(&p));
                if let Some(id) = self.launch(ctx, project, merge_prompt(&p, true), true) {
                    self.auto.auto_chats.push(id);
                }
            }
        }
    }

    /// Settings → General: the two switches.
    pub fn auto_rows(&mut self, ui: &mut Ui) {
        let (mut fix, mut merge) = (self.auto_fix(), self.auto_merge());
        crate::pages::rows(ui, |ui| {
            w::setting_row(
                ui,
                "Auto-Fix",
                &format!("Issues assigned to you in your projects' GitHub repos get a thread that fixes them on a branch and opens a PR, once per issue. Skips issues that already have an open PR; at most {MAX_AUTO} auto threads run at once. Checked every 10 minutes."),
                |ui| w::toggle(ui, &mut fix),
            );
            w::separator(ui);
            w::setting_row(
                ui,
                "Auto-Merge",
                "Your own open PRs in your projects, not drafts, with checks passing (or none) and no changes requested, get a thread that rebases, fixes and merges them, once per head commit.",
                |ui| w::toggle(ui, &mut merge),
            );
        });
        let b = |v: bool| if v { "1" } else { "0" };
        if fix != self.auto_fix() || merge != self.auto_merge() {
            self.store.set("auto_fix", b(fix));
            self.store.set("auto_merge", b(merge));
            // Switching one on looks right away.
            self.auto.last_refresh = None;
            self.auto.last_tick = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(n: u64) -> Issue {
        Issue {
            number: n,
            title: format!("I{n}"),
            url: format!("https://github.com/o/r/issues/{n}"),
            repo: "o/r".into(),
            state: IssueState::Open,
            created: 0,
            updated: n as i64,
            comments: 0,
            author: "x".into(),
            avatar: String::new(),
            labels: vec![],
            assignees: vec!["Me".into()],
            milestone: None,
            mentioned: false,
            linked_pr: false,
        }
    }

    fn projects() -> Vec<(i64, String, String)> {
        vec![(7, "r".into(), "O/R".into())]
    }

    #[test]
    fn picks_issues_to_fix() {
        let mut other_repo = issue(2);
        other_repo.repo = "o/elsewhere".into();
        let mut closed = issue(3);
        closed.state = IssueState::Done;
        let mut has_pr = issue(4);
        has_pr.linked_pr = true;
        let mut not_mine = issue(5);
        not_mine.assignees = vec!["you".into()];
        let data = issues::Fetched { viewer: "me".into(), items: vec![issue(6), other_repo, closed, has_pr, not_mine, issue(1)] };
        let got: Vec<(i64, u64)> = issues_to_fix(&data, &projects(), &HashSet::new()).iter().map(|x| (x.0, x.1.number)).collect();
        assert_eq!(got, vec![(7, 1), (7, 6)], "oldest first, only open + assigned + in a project + no PR");
        let handled: HashSet<String> = [issue_key(&issue(1))].into();
        assert_eq!(issues_to_fix(&data, &projects(), &handled).len(), 1, "never twice");
        assert!(issues_to_fix(&issues::Fetched { viewer: String::new(), ..data }, &projects(), &HashSet::new()).is_empty());
    }

    fn pr(n: u64) -> Pr {
        Pr {
            number: n,
            title: format!("P{n}"),
            url: format!("https://github.com/o/r/pull/{n}"),
            repo: "o/r".into(),
            state: PrState::Open,
            draft: false,
            adds: 1,
            dels: 1,
            created: 0,
            updated: n as i64,
            branch: "b".into(),
            head: format!("sha{n}"),
            review: Review::None,
            checks: Checks::Passing,
            conflicting: false,
            author: "me".into(),
            avatar: String::new(),
            labels: vec![],
            review_requested: false,
        }
    }

    #[test]
    fn picks_prs_to_merge() {
        let mut draft = pr(2);
        draft.draft = true;
        let mut failing = pr(3);
        failing.checks = Checks::Failing;
        let mut changes = pr(4);
        changes.review = Review::Changes;
        let mut theirs = pr(5);
        theirs.author = "you".into();
        let mut no_checks = pr(6);
        no_checks.checks = Checks::None;
        let mut elsewhere = pr(7);
        elsewhere.repo = "x/y".into();
        let data = prs::Fetched { viewer: "Me".into(), items: vec![pr(1), draft, failing, changes, theirs, no_checks, elsewhere] };
        let got: Vec<u64> = prs_to_merge(&data, &projects(), &HashSet::new()).iter().map(|x| x.1.number).collect();
        assert_eq!(got, vec![1, 6]);
        let handled: HashSet<String> = [pr_key(&pr(1))].into();
        assert_eq!(prs_to_merge(&data, &projects(), &handled).len(), 1);
        // A new commit on a handled PR is fair game again.
        let mut pushed = pr(1);
        pushed.head = "newsha".into();
        let data = prs::Fetched { viewer: "me".into(), items: vec![pushed] };
        assert_eq!(prs_to_merge(&data, &projects(), &handled).len(), 1);
    }

    #[test]
    fn prompts_name_the_item() {
        assert!(fix_prompt(&issue(9), false).contains("Fixes #9"));
        assert!(fix_prompt(&issue(9), true).starts_with("(Started by Harbor's Auto-Fix.)"));
        assert!(merge_prompt(&pr(4), false).contains("gh pr merge 4"));
    }
}
