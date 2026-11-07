import type { Chat, Item } from "@harbor/store";
import * as aw from "./autowork.ts";
import type { Engine } from "./engine.ts";
import { now } from "./paths.ts";
import type { Account } from "./providers.ts";

/** Fix and merge threads (the Issues and Pull requests pages' buttons, Auto-Fix and Auto-Merge). */
export class Work {
  private handledList: string[] | null = null;
  /** Lead chats started automatically. */
  private readonly autoChats: number[] = [];
  private lastTick: number | null = null;
  private lastRefresh: number | null = null;

  constructor(private readonly e: Engine) {}

  private handled(): string[] {
    if (this.handledList === null) {
      let v: unknown;
      try {
        v = JSON.parse(this.e.store.get("auto_handled") ?? "[]");
      } catch {
        // not JSON: nothing handled yet
      }
      this.handledList = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    }
    return this.handledList;
  }

  private mark(key: string): void {
    this.handledList = aw.markHandled(this.handled(), key);
    this.e.store.set("auto_handled", JSON.stringify(this.handledList));
  }

  autoFix(): boolean {
    return this.e.store.get("auto_fix") === "1";
  }

  autoMerge(): boolean {
    return this.e.store.get("auto_merge") === "1";
  }

  account(composer: string): Account | undefined {
    const pick = this.e.store.get("gh_agent_account");
    const ok = pick !== null && this.e.account(pick)?.bin != null;
    return this.e.account(ok ? pick : composer) ?? this.e.host.accounts().find((a) => a.kind === "Claude");
  }

  /** A thread in `project` that runs `prompt`, led by the account picked for GitHub work (else the composer's). */
  launch(project: number, prompt: string, composer: { account: string; model: string; effort: string }, quiet: boolean): Chat | null {
    const acc = this.account(composer.account);
    if (!acc) return null;
    // The composer's model and effort go with its provider; another provider's account runs on its defaults.
    const same = this.e.account(composer.account)?.kind === acc.kind;
    const account = acc.id;
    const model = same ? composer.model : acc.kind === "Claude" ? "claude-opus-5-5" : "";
    const effort = same ? composer.effort : "";
    const p = prompt;
    // As when the user writes: their own run lifts a project's pause.
    if (!quiet) this.e.paused.delete(project);
    // Fix and merge threads change the project: full access, whatever the composer is on.
    const chat = this.e.newThread(project, p, { account, model, effort, access: "full", device: "" });
    const item: Item = { kind: "user", text: p, files: [], at: now(), mentions: [], sender: "", intent: "" };
    this.e.transcript(chat.id).items.push(item);
    this.e.persist(chat.id);
    this.e.startTurn(chat.id, p);
    return chat;
  }

  fixIssue(project: number, i: aw.WorkIssue, extra: string, composer: { account: string; model: string; effort: string }): Chat | null {
    const c = this.launch(project, aw.fixPrompt(i, false, extra), composer, false);
    if (c) this.mark(aw.issueKey(i));
    return c;
  }

  mergePr(project: number, p: aw.WorkPr, extra: string, composer: { account: string; model: string; effort: string }): Chat | null {
    const c = this.launch(project, aw.mergePrompt(p, false, extra), composer, false);
    if (c && p.head !== "") this.mark(aw.prKey(p));
    return c;
  }

  private running(): number {
    const live = this.autoChats.filter((id) => this.e.running(id) || this.e.chats.some((c) => c.parent === id && this.e.running(c.id)));
    this.autoChats.splice(0, this.autoChats.length, ...live);
    return live.length;
  }

  tick(data: { issues: aw.IssueData | null; prs: aw.PrData | null; projects: aw.Project[] }, refresh: () => void, composer: { account: string; model: string; effort: string }): void {
    const fix = this.autoFix();
    const merge = this.autoMerge();
    if ((!fix && !merge) || this.e.host.offline) return;
    const t = Date.now();
    if (this.lastTick !== null && t - this.lastTick < aw.TICK_MS) return;
    this.lastTick = t;
    if (this.lastRefresh === null || t - this.lastRefresh > aw.REFRESH_MS) {
      this.lastRefresh = t;
      refresh();
      return;
    }
    const projects = data.projects.filter((p) => !this.e.paused.has(p[0]));
    const handled = new Set(this.handled());
    let room = Math.max(0, aw.MAX_AUTO - this.running());
    if (fix && room > 0 && data.issues) {
      for (const [project, i] of aw.issuesToFix(data.issues, projects, handled).slice(0, room)) {
        this.mark(aw.issueKey(i));
        const c = this.launch(project, aw.fixPrompt(i, true, ""), composer, true);
        if (c) {
          this.autoChats.push(c.id);
          room--;
        }
      }
    }
    if (merge && room > 0 && data.prs) {
      for (const [project, p] of aw.prsToMerge(data.prs, projects, handled).slice(0, room)) {
        this.mark(aw.prKey(p));
        const c = this.launch(project, aw.mergePrompt(p, true, ""), composer, true);
        if (c) this.autoChats.push(c.id);
      }
    }
  }

  /** Switching one on looks right away. */
  setAuto(fix: boolean, merge: boolean): void {
    this.e.store.set("auto_fix", fix ? "1" : "0");
    this.e.store.set("auto_merge", merge ? "1" : "0");
    this.lastRefresh = null;
    this.lastTick = null;
  }
}
