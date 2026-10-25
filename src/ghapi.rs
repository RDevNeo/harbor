//! The phone API's Pull requests and Issues pages (android/PROTOCOL.md): the desktop's lists
//! (prs.rs, issues.rs), fetched with the GitHub CLI and then filtered, sorted and grouped by
//! the same code, and one item's details (prdetail.rs, issuedetail.rs). `gh` takes seconds,
//! so these calls run on a thread of their own, which answers; a list is served again for a
//! minute. The desktop's cheap actions come too: ready for review, close and reopen, and the
//! agent threads that merge a pull request or fix an issue.

use crate::api::{Call, Reply, blocks, err, ok};
use crate::app::App;
use crate::{issuedetail, issues, prdetail, prs};
use eframe::egui;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a fetched list is served again before `gh` is asked anew.
const FRESH: Duration = Duration::from_secs(60);
/// The most diff lines sent.
const MAX_DIFF: usize = 5000;

/// The lists fetched for phones, per state filter (the only one GitHub applies).
#[derive(Default)]
pub struct Cache {
    prs: Vec<(prs::StateF, Instant, Arc<prs::Fetched>)>,
    issues: Vec<(issues::StateF, Instant, Arc<issues::Fetched>)>,
}

pub type Shared = Arc<Mutex<Cache>>;

const PR_SORTS: [(prs::Sort, &str); 7] = [
    (prs::Sort::Ready, "ready"),
    (prs::Sort::Blocked, "blocked"),
    (prs::Sort::Updated, "updated"),
    (prs::Sort::Newest, "newest"),
    (prs::Sort::Oldest, "oldest"),
    (prs::Sort::Largest, "largest"),
    (prs::Sort::Smallest, "smallest"),
];

const ISSUE_SORTS: [(issues::Sort, &str); 6] = [
    (issues::Sort::Updated, "updated"),
    (issues::Sort::Stale, "stale"),
    (issues::Sort::Newest, "newest"),
    (issues::Sort::Oldest, "oldest"),
    (issues::Sort::MostCommented, "most_commented"),
    (issues::Sort::LeastCommented, "least_commented"),
];

fn param<'a>(call: &'a Call, k: &str) -> Option<&'a str> {
    call.query.iter().find(|(q, _)| q == k).map(|(_, v)| v.as_str()).filter(|v| !v.trim().is_empty())
}

/// Every value of a repeated parameter (`label=a&label=b`).
fn params(call: &Call, k: &str) -> Vec<String> {
    call.query.iter().filter(|(q, v)| q == k && !v.trim().is_empty()).map(|(_, v)| v.trim().to_string()).collect()
}

fn hex(c: [u8; 3]) -> String {
    format!("{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

fn labels_json(l: &[(String, [u8; 3])]) -> Value {
    json!(l.iter().map(|(n, c)| json!({ "name": n, "color": hex(*c) })).collect::<Vec<_>>())
}

/// A pull request or issue page on GitHub, as `gh` may be handed it: nothing but
/// `https://github.com/<owner>/<repo>/<kind>/<number>` (no flags, no other hosts).
pub fn gh_url(s: &str, kind: &str) -> Option<String> {
    let s = s.trim();
    let rest = s.strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let name = |p: &str| !p.is_empty() && !p.starts_with('.') && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let ok = parts.len() == 4 && name(parts[0]) && name(parts[1]) && parts[2] == kind && !parts[3].is_empty() && parts[3].chars().all(|c| c.is_ascii_digit());
    ok.then(|| s.to_string())
}

/// owner/name of a GitHub page's URL.
fn repo_of(url: &str) -> String {
    url.strip_prefix("https://github.com/").unwrap_or(url).splitn(3, '/').take(2).collect::<Vec<_>>().join("/")
}

// ------------------------------------------------------------------ pull requests

/// The list's filters, sort and search from the call (PROTOCOL.md `GET /v1/prs`).
pub fn pr_filters(call: &Call) -> (prs::Filters, prs::Sort, String) {
    use prs::{Checks, Involvement, Review, StateF};
    let f = prs::Filters {
        state: match param(call, "state") {
            Some("all") => StateF::All,
            Some("closed") => StateF::Closed,
            Some("merged") => StateF::Merged,
            _ => StateF::Open,
        },
        involvement: match param(call, "involvement") {
            Some("reviewing") => Involvement::Reviewing,
            Some("authored") => Involvement::Authored,
            _ => Involvement::All,
        },
        author: param(call, "author").map(String::from),
        labels: params(call, "label"),
        draft: match param(call, "draft") {
            Some("only") => Some(true),
            Some("hide") => Some(false),
            _ => None,
        },
        review: match param(call, "review") {
            Some("approved") => Some(Review::Approved),
            Some("changes") => Some(Review::Changes),
            Some("required") => Some(Review::Required),
            Some("none") => Some(Review::None),
            _ => None,
        },
        checks: match param(call, "checks") {
            Some("passing") => Some(Checks::Passing),
            Some("failing") => Some(Checks::Failing),
            Some("pending") => Some(Checks::Pending),
            _ => None,
        },
        project: param(call, "project").map(String::from),
    };
    let sort = PR_SORTS.iter().find(|s| Some(s.1) == param(call, "sort")).map_or(prs::Sort::Ready, |s| s.0);
    (f, sort, param(call, "q").unwrap_or("").to_string())
}

fn pr_state(p: &prs::Pr) -> &'static str {
    match p.state {
        prs::PrState::Open => "open",
        prs::PrState::Closed => "closed",
        prs::PrState::Merged => "merged",
    }
}

pub fn pr_json(p: &prs::Pr) -> Value {
    json!({
        "number": p.number, "title": p.title, "url": p.url, "repo": p.repo, "state": pr_state(p), "draft": p.draft,
        "adds": p.adds, "dels": p.dels, "created_ms": p.created * 1000, "updated_ms": p.updated * 1000, "branch": p.branch,
        "review": match p.review { prs::Review::Approved => "approved", prs::Review::Changes => "changes", prs::Review::Required => "required", prs::Review::None => "none" },
        "checks": match p.checks { prs::Checks::Passing => "passing", prs::Checks::Failing => "failing", prs::Checks::Pending => "pending", prs::Checks::None => "none" },
        "conflicting": p.conflicting, "author": p.author, "labels": labels_json(&p.labels), "review_requested": p.review_requested,
    })
}

/// The page: its sections, and what the filter pickers offer.
pub fn prs_page(d: &prs::Fetched, f: &prs::Filters, search: &str, sort: prs::Sort) -> Value {
    let groups: Vec<Value> =
        prs::groups(d, f, search, sort).iter().map(|g| json!({ "key": g.key, "label": g.label, "items": g.items.iter().map(pr_json).collect::<Vec<_>>() })).collect();
    json!({
        "viewer": d.viewer,
        "total": d.items.len(),
        "groups": groups,
        "authors": prs::authors(d).iter().map(|(a, n)| json!({ "login": a, "n": n })).collect::<Vec<_>>(),
        "labels": prs::labels(d).iter().map(|(l, c, n)| json!({ "name": l, "color": hex(*c), "n": n })).collect::<Vec<_>>(),
        "sorts": PR_SORTS.iter().map(|(s, id)| json!({ "id": id, "label": s.label() })).collect::<Vec<_>>(),
    })
}

fn pr_full_json(f: &prdetail::Full) -> Value {
    use prdetail::{CheckState, Event};
    let checks: Vec<Value> = f
        .checks
        .iter()
        .map(|c| {
            let s = match c.state {
                CheckState::Pass => "pass",
                CheckState::Fail => "fail",
                CheckState::Pending => "pending",
                CheckState::Skipped => "skipped",
            };
            json!({ "name": c.name, "state": s, "url": c.url })
        })
        .collect();
    let timeline: Vec<Value> = f
        .timeline
        .iter()
        .map(|(at, who, e)| {
            let mut v = json!({ "at_ms": at * 1000, "who": who });
            match e {
                Event::Opened => v["kind"] = json!("opened"),
                Event::Commit { sha, headline } => {
                    v["kind"] = json!("commit");
                    v["sha"] = json!(sha);
                    v["headline"] = json!(headline);
                }
                Event::Review { state, body } => {
                    v["kind"] = json!("review");
                    v["state"] = json!(state);
                    v["body"] = json!(body);
                    v["blocks"] = json!(blocks(body));
                }
                Event::Comment { body } => {
                    v["kind"] = json!("comment");
                    v["body"] = json!(body);
                    v["blocks"] = json!(blocks(body));
                }
            }
            v
        })
        .collect();
    json!({
        "number": f.number, "title": f.title, "url": f.url, "repo": repo_of(&f.url), "state": f.state.to_ascii_lowercase(), "draft": f.draft,
        "author": f.author, "created_ms": f.created * 1000, "updated_ms": f.updated * 1000, "base": f.base, "head": f.head,
        "adds": f.adds, "dels": f.dels, "files": f.files, "labels": labels_json(&f.labels), "conflicting": f.conflicting,
        "reviewers": f.reviewers.iter().map(|(who, s)| json!({ "login": who, "state": s })).collect::<Vec<_>>(),
        "body": f.body, "blocks": blocks(&f.body), "checks": checks,
        "comments": f.comments.iter().map(|c| json!({ "author": c.author, "at_ms": c.at * 1000, "body": c.body, "blocks": blocks(&c.body) })).collect::<Vec<_>>(),
        "timeline": timeline,
    })
}

pub fn diff_json(diff: &str) -> Value {
    use prdetail::Line;
    let lines = prdetail::parse_diff(diff);
    let shown: Vec<Value> = lines
        .iter()
        .take(MAX_DIFF)
        .map(|l| match l {
            Line::File { path, adds, dels } => json!({ "t": "file", "text": path, "adds": adds, "dels": dels }),
            Line::Hunk(s) => json!({ "t": "hunk", "text": s }),
            Line::Add(s) => json!({ "t": "add", "text": s }),
            Line::Del(s) => json!({ "t": "del", "text": s }),
            Line::Ctx(s) => json!({ "t": "ctx", "text": s }),
        })
        .collect();
    json!({ "lines": shown, "clipped": lines.len() > MAX_DIFF })
}

// ------------------------------------------------------------------ issues

pub fn issue_filters(call: &Call) -> (issues::Filters, issues::Sort, String) {
    use issues::{Assignee, Involvement, StateF};
    let f = issues::Filters {
        state: match param(call, "state") {
            Some("all") => StateF::All,
            Some("closed") => StateF::Closed,
            _ => StateF::Open,
        },
        involvement: match param(call, "involvement") {
            Some("assigned") => Involvement::Assigned,
            Some("authored") => Involvement::Authored,
            Some("mentioned") => Involvement::Mentioned,
            _ => Involvement::All,
        },
        author: param(call, "author").map(String::from),
        assignee: param(call, "assignee").map(|a| if a == "none" { Assignee::Nobody } else { Assignee::Login(a.to_string()) }),
        labels: params(call, "label"),
        milestone: param(call, "milestone").map(|m| (m != "none").then(|| m.to_string())),
        project: param(call, "project").map(String::from),
    };
    let sort = ISSUE_SORTS.iter().find(|s| Some(s.1) == param(call, "sort")).map_or(issues::Sort::Updated, |s| s.0);
    (f, sort, param(call, "q").unwrap_or("").to_string())
}

fn issue_state(s: issues::IssueState) -> &'static str {
    match s {
        issues::IssueState::Open => "open",
        issues::IssueState::Done => "done",
        issues::IssueState::NotPlanned => "not_planned",
    }
}

pub fn issue_json(i: &issues::Issue) -> Value {
    json!({
        "number": i.number, "title": i.title, "url": i.url, "repo": i.repo, "state": issue_state(i.state),
        "created_ms": i.created * 1000, "updated_ms": i.updated * 1000, "comments": i.comments, "author": i.author,
        "labels": labels_json(&i.labels), "assignees": i.assignees, "milestone": i.milestone, "mentioned": i.mentioned, "linked_pr": i.linked_pr,
    })
}

pub fn issues_page(d: &issues::Fetched, f: &issues::Filters, search: &str, sort: issues::Sort) -> Value {
    let groups: Vec<Value> = issues::groups(d, f, search, sort)
        .iter()
        .map(|g| json!({ "key": g.key, "label": g.label, "items": g.items.iter().map(issue_json).collect::<Vec<_>>() }))
        .collect();
    let tally = |v: Vec<(String, usize)>| v.iter().map(|(a, n)| json!({ "name": a, "n": n })).collect::<Vec<_>>();
    json!({
        "viewer": d.viewer,
        "total": d.items.len(),
        "groups": groups,
        "authors": issues::authors(d).iter().map(|(a, n)| json!({ "login": a, "n": n })).collect::<Vec<_>>(),
        "assignees": tally(issues::assignees(d)),
        "milestones": tally(issues::milestones(d)),
        "labels": issues::labels(d).iter().map(|(l, c, n)| json!({ "name": l, "color": hex(*c), "n": n })).collect::<Vec<_>>(),
        "sorts": ISSUE_SORTS.iter().map(|(s, id)| json!({ "id": id, "label": s.label() })).collect::<Vec<_>>(),
    })
}

fn issue_full_json(f: &issuedetail::Full) -> Value {
    json!({
        "number": f.number, "title": f.title, "url": f.url, "repo": repo_of(&f.url), "state": issue_state(f.state),
        "author": f.author, "created_ms": f.created * 1000, "updated_ms": f.updated * 1000, "labels": labels_json(&f.labels),
        "assignees": f.assignees, "milestone": f.milestone, "body": f.body, "blocks": blocks(&f.body),
        "comments": f.comments.iter().map(|c| json!({ "author": c.author, "at_ms": c.at * 1000, "body": c.body, "blocks": blocks(&c.body) })).collect::<Vec<_>>(),
    })
}

// ------------------------------------------------------------------ the calls

/// A list from the cache while it's fresh, else from GitHub (and then kept).
fn cached<S: Copy + PartialEq, T>(list: &mut Vec<(S, Instant, Arc<T>)>, state: S, refresh: bool) -> Option<Arc<T>> {
    list.iter().find(|(s, at, _)| *s == state && !refresh && at.elapsed() < FRESH).map(|x| x.2.clone())
}

fn keep<S: Copy + PartialEq, T>(list: &mut Vec<(S, Instant, Arc<T>)>, state: S, v: Arc<T>) {
    list.retain(|x| x.0 != state);
    list.push((state, Instant::now(), v));
}

/// After a change on GitHub the lists are fetched anew, but stay known: Merge with… and Fix
/// with… find their item in them.
fn expire<S, T>(list: &mut [(S, Instant, Arc<T>)]) {
    let old = Instant::now().checked_sub(FRESH).unwrap_or_else(Instant::now);
    for x in list.iter_mut() {
        x.1 = old;
    }
}

impl App {
    /// The GitHub calls of the phone API. None: a thread answers (`gh` is slow).
    pub fn api_github(&mut self, call: &Call, ctx: &egui::Context) -> Option<Reply> {
        let p: Vec<&str> = call.path.iter().map(String::as_str).collect();
        let cache = self.api.gh.clone();
        let reply = call.reply.clone();
        // Answers from a thread.
        let later = move |job: Box<dyn FnOnce() -> Reply + Send>| {
            std::thread::spawn(move || {
                let _ = reply.send(job());
            });
            None
        };
        let url_of = |kind: &str| gh_url(param(call, "url").or(call.body["url"].as_str()).unwrap_or(""), kind);
        let projects = self.gh_projects(call.global);
        match (call.method.as_str(), p.as_slice()) {
            ("GET", ["v1", "prs"]) => {
                let (f, sort, search) = pr_filters(call);
                let refresh = param(call, "refresh") == Some("1");
                let repos = self.gh_repos();
                later(Box::new(move || {
                    let repos = repos();
                    let hit = cached(&mut cache.lock().unwrap().prs, f.state, refresh);
                    let d = match hit {
                        Some(d) => d,
                        None => match prs::fetch(f.state, &repos) {
                            Ok(d) => {
                                let d = Arc::new(d);
                                keep(&mut cache.lock().unwrap().prs, f.state, d.clone());
                                d
                            }
                            Err(e) => return err(502, e),
                        },
                    };
                    let mut v = prs_page(&d, &f, &search, sort);
                    v["projects"] = projects();
                    ok(v)
                }))
            }
            ("GET", ["v1", "issues"]) => {
                let (f, sort, search) = issue_filters(call);
                let refresh = param(call, "refresh") == Some("1");
                let repos = self.gh_repos();
                later(Box::new(move || {
                    let repos = repos();
                    let hit = cached(&mut cache.lock().unwrap().issues, f.state, refresh);
                    let d = match hit {
                        Some(d) => d,
                        None => match issues::fetch(f.state, &repos) {
                            Ok(d) => {
                                let d = Arc::new(d);
                                keep(&mut cache.lock().unwrap().issues, f.state, d.clone());
                                d
                            }
                            Err(e) => return err(502, e),
                        },
                    };
                    let mut v = issues_page(&d, &f, &search, sort);
                    v["projects"] = projects();
                    ok(v)
                }))
            }
            ("GET", ["v1", "prs", "view"]) => {
                let Some(url) = url_of("pull") else { return Some(err(400, "url must be a GitHub pull request")) };
                let agent = self.agent_label();
                later(Box::new(move || match prdetail::fetch(&url) {
                    Ok(f) => {
                        let mut v = pr_full_json(&f);
                        v["agent"] = json!(agent);
                        ok(v)
                    }
                    Err(e) => err(502, e),
                }))
            }
            ("GET", ["v1", "prs", "diff"]) => {
                let Some(url) = url_of("pull") else { return Some(err(400, "url must be a GitHub pull request")) };
                later(Box::new(move || match prdetail::gh(&["pr", "diff", &url]) {
                    Ok(b) => ok(diff_json(&String::from_utf8_lossy(&b))),
                    Err(e) => err(502, e),
                }))
            }
            ("GET", ["v1", "issues", "view"]) => {
                let Some(url) = url_of("issues") else { return Some(err(400, "url must be a GitHub issue")) };
                let agent = self.agent_label();
                later(Box::new(move || match issuedetail::fetch(&url) {
                    Ok(f) => {
                        let mut v = issue_full_json(&f);
                        v["agent"] = json!(agent);
                        ok(v)
                    }
                    Err(e) => err(502, e),
                }))
            }
            // A draft PR, ready for review (gh pr ready).
            ("POST", ["v1", "prs", "ready"]) => {
                let Some(url) = url_of("pull") else { return Some(err(400, "url must be a GitHub pull request")) };
                later(Box::new(move || match prdetail::gh(&["pr", "ready", &url]) {
                    Ok(_) => {
                        expire(&mut cache.lock().unwrap().prs);
                        ok(json!({ "ok": true }))
                    }
                    Err(e) => err(502, e),
                }))
            }
            ("POST", ["v1", "issues", action @ ("close" | "reopen")]) => {
                let Some(url) = url_of("issues") else { return Some(err(400, "url must be a GitHub issue")) };
                let action = action.to_string();
                later(Box::new(move || match prdetail::gh(&["issue", &action, &url]) {
                    Ok(_) => {
                        expire(&mut cache.lock().unwrap().issues);
                        ok(json!({ "ok": true }))
                    }
                    Err(e) => err(502, e),
                }))
            }
            // The agent threads, as the desktop's Merge with… and Fix with… start them.
            ("POST", ["v1", "prs", "merge"]) => {
                let Some(url) = url_of("pull") else { return Some(err(400, "url must be a GitHub pull request")) };
                let pr = cache.lock().unwrap().prs.iter().find_map(|(_, _, d)| d.items.iter().find(|p| p.url == url).cloned());
                let Some(pr) = pr else { return Some(err(409, "refresh the list first")) };
                let Some(project) = self.gh_project_of(&pr.repo) else { return Some(err(409, crate::issues::NOT_PROJECT)) };
                let extra = call.body["extra"].as_str().unwrap_or("").to_string();
                Some(self.api_agent_thread(call.global, |app| app.merge_pr(ctx, project, &pr, &extra)))
            }
            ("POST", ["v1", "issues", "fix"]) => {
                let Some(url) = url_of("issues") else { return Some(err(400, "url must be a GitHub issue")) };
                let issue = cache.lock().unwrap().issues.iter().find_map(|(_, _, d)| d.items.iter().find(|i| i.url == url).cloned());
                let Some(issue) = issue else { return Some(err(409, "refresh the list first")) };
                let Some(project) = self.gh_project_of(&issue.repo) else { return Some(err(409, crate::issues::NOT_PROJECT)) };
                let extra = call.body["extra"].as_str().unwrap_or("").to_string();
                Some(self.api_agent_thread(call.global, |app| app.fix_issue(ctx, project, &issue, &extra)))
            }
            _ => Some(err(404, "unknown call")),
        }
    }

    /// The projects with a GitHub repo, as the phone names them (by path with global ids), for
    /// a thread to finish: it reads the remotes of the ones whose git status isn't known yet.
    fn gh_projects(&self, global: bool) -> impl FnOnce() -> Value + Send + 'static {
        let pid = |id: i64| if global { self.repo(id).map_or(json!(id), |r| json!(r.path.to_string_lossy())) } else { json!(id) };
        let mut known: Vec<Value> = self.pr_projects().into_iter().map(|(id, name, repo)| json!({ "id": pid(id), "name": name, "repo": repo })).collect();
        let missing: Vec<(Value, String, std::path::PathBuf)> =
            self.repos.iter().filter(|r| !self.git.contains_key(&r.id)).map(|r| (pid(r.id), r.name.clone(), r.path.clone())).collect();
        move || {
            for (id, name, path) in missing {
                if let Some(repo) = crate::git::status(&path).and_then(|s| s.remote).and_then(|r| prs::github_repo(&r)) {
                    known.push(json!({ "id": id, "name": name, "repo": repo }));
                }
            }
            json!(known)
        }
    }

    fn gh_project_of(&self, repo: &str) -> Option<i64> {
        self.pr_projects().into_iter().find(|p| p.2.eq_ignore_ascii_case(repo)).map(|p| p.0)
    }

    /// Runs `start` (it starts and opens a thread) and answers with the new chat; the
    /// desktop stays where it was.
    fn api_agent_thread(&mut self, global: bool, start: impl FnOnce(&mut App)) -> Reply {
        let before = self.chats.iter().map(|c| c.id).max().unwrap_or(0);
        let (view, focus) = (self.view, self.focus_composer);
        start(self);
        self.view = view;
        self.focus_composer = focus;
        match self.chats.iter().map(|c| c.id).max().filter(|m| *m > before) {
            Some(id) if global => ok(json!({ "id": self.chat(id).map(|c| c.gid.clone()) })),
            Some(id) => ok(json!({ "id": id })),
            None => err(409, "no account to run the agent with"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(q: &[(&str, &str)]) -> Call {
        let (tx, _) = std::sync::mpsc::channel();
        Call {
            method: "GET".into(),
            path: vec!["v1".into(), "prs".into()],
            query: q.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: Value::Null,
            token: String::new(),
            device: String::new(),
            reply: tx,
            global: false,
        }
    }

    #[test]
    fn only_github_pages_reach_gh() {
        assert!(gh_url("https://github.com/o/r/pull/12", "pull").is_some());
        assert!(gh_url(" https://github.com/my-org/repo.rs/issues/3 ", "issues").is_some());
        for bad in ["--help", "https://github.com/o/r/pull/12/files", "https://evil.example/o/r/pull/1", "https://github.com/o/r/issues/1", "https://github.com/../r/pull/1", "https://github.com/o/r/pull/1a"] {
            assert!(gh_url(bad, "pull").is_none(), "{bad}");
        }
    }

    #[test]
    fn filters_from_the_query() {
        let (f, sort, q) = pr_filters(&call(&[("state", "merged"), ("involvement", "authored"), ("label", "bug"), ("label", "ui"), ("draft", "hide"), ("review", "approved"), ("checks", "failing"), ("project", "o/r"), ("sort", "largest"), ("q", "fix")]));
        assert_eq!(f.state, prs::StateF::Merged);
        assert!(f.involvement == prs::Involvement::Authored && f.labels == ["bug", "ui"] && f.draft == Some(false));
        assert!(f.review == Some(prs::Review::Approved) && f.checks == Some(prs::Checks::Failing) && f.project.as_deref() == Some("o/r"));
        assert!(sort == prs::Sort::Largest && q == "fix");
        let (f, sort, _) = pr_filters(&call(&[]));
        assert!(f == prs::Filters::default() && sort == prs::Sort::Ready);
        let (f, sort, _) = issue_filters(&call(&[("state", "closed"), ("assignee", "none"), ("milestone", "none"), ("sort", "most_commented")]));
        assert!(f.state == issues::StateF::Closed && f.assignee == Some(issues::Assignee::Nobody) && f.milestone == Some(None));
        assert_eq!(sort, issues::Sort::MostCommented);
        let (f, _, _) = issue_filters(&call(&[("assignee", "me"), ("milestone", "v1")]));
        assert!(f.assignee == Some(issues::Assignee::Login("me".into())) && f.milestone == Some(Some("v1".into())));
    }

    #[test]
    fn pages_on_the_wire() {
        let pr = prs::Pr {
            number: 7, title: "Fix it".into(), url: "https://github.com/o/r/pull/7".into(), repo: "o/r".into(), state: prs::PrState::Open, draft: false,
            adds: 3, dels: 1, created: 10, updated: 20, branch: "fix".into(), head: "abc".into(), review: prs::Review::Approved, checks: prs::Checks::Passing,
            conflicting: false, author: "me".into(), avatar: String::new(), labels: vec![("bug".into(), [255, 0, 16])], review_requested: false,
        };
        let d = prs::Fetched { viewer: "me".into(), items: vec![pr] };
        let v = prs_page(&d, &prs::Filters::default(), "", prs::Sort::Ready);
        assert_eq!(v["groups"][0]["key"], "authored");
        let p = &v["groups"][0]["items"][0];
        assert_eq!((p["state"].as_str(), p["review"].as_str(), p["checks"].as_str(), p["updated_ms"].as_i64()), (Some("open"), Some("approved"), Some("passing"), Some(20_000)));
        assert_eq!(p["labels"][0], json!({ "name": "bug", "color": "ff0010" }));
        assert_eq!(v["labels"][0]["n"], 1);
        assert_eq!(v["sorts"][0], json!({ "id": "ready", "label": "Merge readiness" }));
        let d = diff_json("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(d["lines"][0], json!({ "t": "file", "text": "x", "adds": 1, "dels": 1 }));
        assert_eq!(d["lines"].as_array().unwrap().len(), 4);
    }
}
