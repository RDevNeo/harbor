import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Ref, fileKind, listFiles, parseRefs, rankFiles, rankRefs, refLine, rowJson, tagged, tokens, word } from "../src/logic/tags.ts";

function r(number: number, title: string, pr: boolean, state: Ref["state"], updated: number): Ref {
  return { number, title, url: `https://github.com/o/r/${pr ? "pull" : "issues"}/${number}`, pr, state, updated };
}

test("finds_the_word_at_the_cursor", () => {
  expect(word("@src", 4)).toEqual({ trigger: "@", start: 0, end: 4, query: "src" });
  expect(word("look at @ch now", 11)).toEqual({ trigger: "@", start: 8, end: 11, query: "ch" });
  const w = word("fix #12", 7);
  expect(w === null ? null : [w.trigger, w.query]).toEqual(["#", "12"]);
  expect(word("(#4", 3)?.start).toBe(1);
  expect(word("@", 1)?.query).toBe("");
  // Not in an email address, a heading's `##`, or after the word.
  expect(word("me@host", 7)).toBeNull();
  expect(word("## Title", 2)).toBeNull();
  expect(word("@a ", 3)).toBeNull();
  expect(word("/cmd", 4)).toBeNull();
});

test("finds_tags_in_a_message", () => {
  const text = "see @src/chat.rs, and #12 (also #12) or me@mail.com, @src/chat.rs again #x #7.";
  expect(tagged(text)).toEqual({ files: ["src/chat.rs"], numbers: [12, 7] });
  expect(tokens("a @b #3 c#4 #x")).toEqual([
    [2, 2],
    [5, 2],
  ]);
  // Offsets are UTF-16 units here (Rust's are bytes: (3, 3)).
  expect(tokens("é @ñ.")).toEqual([[2, 2]]);
  expect(tokens("@app/(group)/page.tsx")).toEqual([[0, 21]]);
});

test("an_images_number_is_no_issue", () => {
  const text = "this [Image #1] and Image #2, image #3, IMAGE  #4 but #5 and myimage #6";
  expect(tagged(text).numbers).toEqual([5, 6]);
  expect(tokens("[Image #12]")).toEqual([]);
  // The menu doesn't open on it either.
  expect(word("Image #1", 8)).toBeNull();
  expect(word("[Image #", 8)).toBeNull();
  expect(word("é image #1", 10)).toBeNull();
  expect(word("fix #1", 6)?.query).toBe("1");
});

test("ranks_files", () => {
  const files = [
    "src/components/creators/creator-profile-dialog.tsx",
    "src/components/creators/creator-card.tsx",
    "src/chat.rs",
    "src/chatbox/mod.rs",
    "docs/chat.md",
    "README.md",
    "src/app.rs",
    "android/src/dev/harbor/app/Chat.java",
  ];
  const find = (q: string) => rankFiles(files, q, 10);
  // The name exactly, then by stem (shorter paths first), then as a prefix.
  expect(find("chat.rs").slice(0, 1)).toEqual(["src/chat.rs"]);
  expect(find("chat").slice(0, 4)).toEqual(["src/chat.rs", "docs/chat.md", "android/src/dev/harbor/app/Chat.java", "src/chatbox/mod.rs"]);
  // A word inside the name, and letters in order.
  expect(find("profile").slice(0, 1)).toEqual(["src/components/creators/creator-profile-dialog.tsx"]);
  expect(find("cpd").slice(0, 1)).toEqual(["src/components/creators/creator-profile-dialog.tsx"]);
  // A folder in the query matches the path.
  expect(find("creators/card").slice(0, 1)).toEqual(["src/components/creators/creator-card.tsx"]);
  expect(find("zzz")).toEqual([]);
  // Nothing typed: the shallowest first.
  expect(find("").slice(0, 1)).toEqual(["README.md"]);
  expect(rankFiles(files, "", 3).length).toBe(3);
});

test("ranks_issues_and_prs", () => {
  const refs = [r(12, "Composer tagging", false, "open", 5), r(120, "Fix tagging on phones", true, "open", 9), r(7, "Old tagging bug", false, "closed", 10), r(3, "Release notes", true, "merged", 1)];
  const find = (q: string) => rankRefs(refs, q, 10).map((x) => x.number);
  expect(find("12")).toEqual([12, 120]);
  expect(find("#3")).toEqual([3]);
  // Title words; open before closed; the latest first among equals.
  expect(find("tag")).toEqual([120, 12, 7]);
  expect(find("rlnts")).toEqual([3]);
  expect(find("")).toEqual([120, 12, 7, 3]);
});

test("lists_a_folder_without_git", () => {
  const d = join(tmpdir(), `harbor-tags-walk-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  for (const f of ["notes.md", "docs/plan.md", "docs/old/a.txt", ".hidden/x", "node_modules/p/i.js", ".env"]) {
    const p = join(d, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x");
  }
  expect(listFiles(d)).toEqual(["docs/old/a.txt", "docs/plan.md", "notes.md"]);
  expect(listFiles(join(d, "missing"))).toBeNull();
  rmSync(d, { recursive: true, force: true });
});

test("file_kinds", () => {
  expect(fileKind("src/a.tsx")).toBe("tsx");
  expect(fileKind("a.ts")).toBe("ts");
  expect(fileKind("src/main.rs")).toBe("rs");
  expect(fileKind("Cargo.toml")).toBe("json");
  expect(fileKind("README.MD")).toBe("md");
  expect(fileKind("Makefile")).toBe("file");
  expect(fileKind("x.py")).toBe("code");
});

test("reads_githubs_answer", () => {
  const v = parseRefs({
    data: {
      repository: {
        issues: { nodes: [{ number: 4, title: "Bug", url: "u4", state: "OPEN", updatedAt: "2026-10-01T00:00:00Z" }] },
        pullRequests: {
          nodes: [
            { number: 5, title: "Fix", url: "u5", state: "OPEN", isDraft: true, updatedAt: "2026-10-02T00:00:00Z" },
            { number: 6, title: "Done", url: "u6", state: "MERGED", isDraft: false, updatedAt: "2026-09-01T00:00:00Z" },
          ],
        },
      },
    },
  });
  expect(v.map((x) => [x.number, x.pr, x.state])).toEqual([
    [5, true, "draft"],
    [4, false, "open"],
    [6, true, "merged"],
  ]);
  const second = v[1];
  expect(second === undefined ? null : refLine(second)).toBe('#4: GitHub issue "Bug" (open), u4');
});

test("rows_for_the_phone", () => {
  const f = rowJson({ kind: "file", path: "src/components/x.tsx" });
  expect([f.insert, f.name, f.dir, f.icon]).toEqual(["@src/components/x.tsx", "x.tsx", "src/components", "tsx"]);
  const i = rowJson({ kind: "ref", ref: r(9, "T", true, "open", 0) });
  expect([i.kind, i.insert, i.number]).toEqual(["pr", "#9", 9]);
});
