import { describe, expect, test } from "bun:test";
import type { ghapi } from "@harbor/mcp";
import { checksSummary, codeState, header, LINK_MENU, moreMenu, newDetail, reviewTone, summary, timeline } from "../src/logic/prdetail.ts";

const NOW = 1_800_000_000;
const full = (o: Partial<ghapi.PrFull> = {}): ghapi.PrFull => ({
  number: 7, title: "T", url: "https://github.com/o/r/pull/7", state: "OPEN", draft: false, author: "a", created: NOW - 9000, updated: NOW - 7300, base: "main", head: "feat", adds: 1204, dels: 3, files: 2,
  labels: [["bug", [255, 0, 0]]], reviewers: [["c", "APPROVED"], ["b", "PENDING"]], body: "text", checks: [], comments: [{ author: "d", at: NOW - 100, body: "hi" }, { author: "e", at: NOW - 50, body: "yo" }], timeline: [], conflicting: false, ...o,
});
const facts = { url: "https://github.com/o/r/pull/7", list: undefined, project: undefined, now: NOW, notProject: "no project" };

describe("prdetail.rs header", () => {
  test("it shows the list row's facts until the full PR arrives", () => {
    const list: ghapi.Pr = { number: 7, title: "From list", url: facts.url, repo: "O/R", state: "open", draft: true, adds: 1, dels: 1, created: 0, updated: NOW - 7300, branch: "b", head: "", review: "none", checks: "none", conflicting: false, author: "zed", avatar: "", labels: [], review_requested: false };
    const h = header(newDetail(), { ...facts, list });
    expect([h.title, h.repo, h.author, h.letter, h.updated, h.draft, h.open, h.has_full, h.checkout]).toEqual(["From list", "O/R", "zed", "Z", "· updated 2h ago", true, true, false, "gh pr checkout 7"]);
  });

  test("with the full PR it shows base, head, files and size", () => {
    const d = { ...newDetail(), full: full({ conflicting: true }) };
    const h = header(d, facts);
    expect([h.repo, h.base, h.head, h.files, h.adds, h.dels, h.conflicting, h.checks_text]).toEqual(["o/r", "main", "feat", "2 files", "+1,204", "-3", true, "No checks reported"]);
  });

  test("merge and check out explain themselves when there's no project or no list row", () => {
    const d = { ...newDetail(), full: full() };
    expect([header(d, facts).merge_enabled, header(d, facts).merge_tip, header(d, facts).checkout_tip]).toEqual([false, "no project", "Add this repo as a project to check it out here"]);
    const list: ghapi.Pr | undefined = undefined;
    expect(header(d, { ...facts, list, project: 3 }).merge_tip).toBe("Refresh the list first");
    expect(header(d, { ...facts, project: 3 }).checkout_tip).toBe("Check out this branch in a terminal (gh pr checkout)");
  });

  test("a closed PR hides the actions; a busy draft says it is marking ready", () => {
    expect(header({ ...newDetail(), full: full({ state: "MERGED" }) }, facts).open).toBe(false);
    const h = header({ ...newDetail(), full: full({ draft: true }), busy: true }, facts);
    expect([h.draft, h.ready_label]).toEqual([true, "Marking ready…"]);
    expect(header({ ...newDetail(), full: full({ draft: true }) }, facts).ready_label).toBe("Ready for review");
  });

  test("an error from the fetch or a mutation shows under the title", () => {
    expect(header({ ...newDetail(), fullError: "gh failed" }, facts).error).toBe("gh failed");
    expect(header({ ...newDetail(), error: "no" }, facts).error).toBe("no");
  });
});

describe("prdetail.rs summary", () => {
  test("the checks line counts failures first, then running ones", () => {
    const c = (state: ghapi.PrFull["checks"][number]["state"]) => ({ name: "x", url: "", state });
    expect(checksSummary([])[2]).toBe("No checks reported");
    expect(checksSummary([c("pass"), c("fail"), c("pending")])[2]).toBe("1 of 3 checks failing");
    expect(checksSummary([c("pass"), c("pending"), c("pending")])[2]).toBe("2 checks running");
    expect(checksSummary([c("pass"), c("skipped")])).toEqual(["\u{e226}", "green", "All checks passed"]);
  });

  test("reviewers carry their review's icon and words", () => {
    expect(reviewTone("APPROVED")[2]).toBe("approved");
    expect(reviewTone("CHANGES_REQUESTED")[2]).toBe("requested changes");
    expect(reviewTone("PENDING")[2]).toBe("review requested");
    const s = summary(newDetail(), full(), NOW);
    expect(s.reviewers.map((r) => [r.who, r.tip])).toEqual([["c", "approved"], ["b", "review requested"]]);
  });

  test("comments come newest first, with the count in the title", () => {
    const s = summary(newDetail(), full(), NOW);
    expect([s.comments_title, s.comments.map((c) => c.who), s.comments[0]?.what]).toEqual(["Comments (2)", ["e", "d"], "commented · just now"]);
    expect([s.desc_open, s.comments_open, s.checks_open]).toEqual([true, true, false]);
  });

  test("an empty description is empty, not whitespace", () => {
    expect(summary(newDetail(), full({ body: "  \n" }), NOW).body).toBe("");
  });
});

describe("prdetail.rs timeline and code", () => {
  test("events and notes come in the order given, reviews with a body as notes", () => {
    const t = timeline(full({ timeline: [[NOW - 9000, "a", { kind: "opened" }], [NOW - 8000, "a", { kind: "commit", sha: "abc1234", headline: "first" }], [NOW - 7000, "c", { kind: "review", state: "APPROVED", body: "" }], [NOW - 6000, "c", { kind: "review", state: "CHANGES_REQUESTED", body: "fix" }], [NOW - 5000, "d", { kind: "comment", body: "hi" }]] }), NOW);
    expect(t.map((i) => (i.kind === "event" ? i.event.text : `note:${i.note.who}:${i.note.what.split(" · ")[0]}`))).toEqual(["a opened this pull request", "abc1234  first", "c approved", "note:c:requested changes", "note:d:commented"]);
    expect(t[1]?.kind === "event" && t[1].event.mono).toBe(true);
  });

  test("the code tab loads, fails, is empty or has lines", () => {
    expect(codeState(newDetail())).toEqual({ kind: "loading" });
    expect(codeState({ ...newDetail(), diffError: "x" })).toEqual({ kind: "error", text: "x" });
    expect(codeState({ ...newDetail(), diff: [] })).toEqual({ kind: "empty" });
    const s = codeState({ ...newDetail(), diff: [{ t: "file", path: "a.ts", adds: 2, dels: 1 }, { t: "add", text: "\tx" }, { t: "ctx", text: "y" }] });
    expect(s.kind === "lines" && s.lines.map((l) => [l.t, l.path, l.adds, l.dels, l.text])).toEqual([["file", "a.ts", "+2", "-1", ""], ["add", "", "", "", "    x"], ["ctx", "", "", "", "y"]]);
  });

  test("the more menu offers review only for projects, and separates the open and copy actions", () => {
    expect(moreMenu(false).map((m) => m.act)).toEqual(["refresh", "web", "copy_link", "copy_number", "copy_checkout"]);
    expect(moreMenu(true).map((m) => m.act)[1]).toBe("review");
    expect(moreMenu(true).filter((m) => m.sep).map((m) => m.act)).toEqual(["web"]);
    expect(LINK_MENU.map((m) => m.label)).toEqual(["Copy link", "Open on GitHub"]);
  });
});
