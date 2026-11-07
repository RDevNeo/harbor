import { actions, apiMoveTargets, apiPeople, codeState, movePcBlocker, movePcTargets, apiPeopleSet, type Call, confirmOwner, err, gatherVersions, type Hub, type Json, meshPcs, type OwnerSources, ok, type PhoneRoutes, profileCheckJson, project, type ProfileScheduler, type Reply, versionsInput, versionsJson } from "./packages/net/src/index.ts";
import { type Chat, cost, type Store, usageCtl } from "./packages/store/src/index.ts";
import { type Engine, providers } from "./packages/agents/src/index.ts";
import { forkable } from "./packages/agents/src/fork.ts";
import { machines } from "./packages/mcp/src/index.ts";
import { agentSettled, loadMarks } from "./packages/ui/src/logic/teamui.ts";
import { excerptOf, mentionAgent, mentionOf, mentionToJson, type MentionableItem } from "./packages/ui/src/logic/mentions.ts";
import { parseSnooze, snoozePresets, snoozePreview } from "./packages/ui/src/logic/sidebar.ts";
import { sidebartree } from "./packages/store/src/index.ts";
import { composerRoutes } from "./phonecomposer.ts";
import { basename } from "node:path";
import { worktree as wt, wtclean } from "./packages/agents/src/index.ts";
import type { ProjectClones } from "./projectclones.ts";
import type { ProjectsApi } from "./projectsapi.ts";
import type { WorkspaceMoves } from "./workspacemoves.ts";
import type { Target, Worktrees } from "./worktrees.ts";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { commits } from "./packages/agents/src/index.ts";
import { ghapi, prdetail } from "./packages/mcp/src/index.ts";
import { repoDir } from "./packages/store/src/index.ts";
import { discord, mcp, whatsapp } from "./packages/mcp/src/index.ts";
import { qrRows } from "./packages/ui/src/qr.ts";
import { googleDesktopClient, googlePhoneCode, googlePhoneFinish, googlePhoneStart, googleWebClientId } from "./packages/mcp/src/signin.ts";
import * as limits from "./packages/store/src/limits.ts";

export interface RouteHost {
  store: Store;
  hub: Hub;
  engine: () => Engine;
  phone: () => PhoneRoutes;
  uploadId(path: string): string | null;
  versionsOwn(): { hostname: string; version: string; update: unknown; served: number };
  owners: OwnerSources;
  profile: ProfileScheduler;
  profileCheck(): Json;
  republish(): void;
  worktrees: Worktrees;
  projectClones: ProjectClones;
  projects: ProjectsApi;
  /** Move to workspace… (`/v1/chats/{id}/workspace`, `/workspaces`). */
  moves?: WorkspaceMoves;
  wantPr(chat: number): void;
}

const now = (): number => Math.floor(Date.now() / 1000);
const zone = (at: number): number => -new Date(at * 1000).getTimezoneOffset() * 60;
const query = (c: Call, k: string): string | null => c.query.find(([q]) => q === k)?.[1] ?? null;
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const WT_CLEAN = wtclean.KEYS;
const body = (c: Call): Record<string, unknown> => (typeof c.body === "object" && c.body !== null && !Array.isArray(c.body) ? (c.body as Record<string, unknown>) : {});

export function phoneRoutes(h: RouteHost): (call: Call, chat: Chat | null) => Promise<Reply | null> {
  const composer = composerRoutes({ store: h.store, engine: h.engine, phone: h.phone, homeName: (c) => (c.home !== "" ? h.hub.mesh.nameOf(c.home) : h.hub.mesh.me.name), touch: () => h.hub.touch(null, true), place: (repo) => h.projectClones.place(repo) });
  const resolve = (ref: string): Chat | null => {
    const id = /^-?\d+$/.test(ref) ? Number(ref) : h.hub.mesh.byGid(ref);
    return id === null ? null : (h.engine().chat(id) ?? null);
  };

  const snoozed = (): Map<string, number> => {
    try {
      const v: unknown = JSON.parse(h.store.get("snoozed") ?? "{}");
      return new Map(Object.entries(typeof v === "object" && v !== null ? v : {}).filter((e): e is [string, number] => typeof e[1] === "number"));
    } catch {
      return new Map();
    }
  };
  const snoozeUntil = (key: string): number | null => {
    const t = snoozed().get(key);
    return t !== undefined && t > now() ? t : null;
  };
  const setSnooze = (key: string, until: number | null): void => {
    const all = snoozed();
    if (until === null) all.delete(key);
    else all.set(key, until);
    h.store.set("snoozed", JSON.stringify(Object.fromEntries(all)));
    h.hub.touch(null, true);
  };
  const label = (c: Chat): Json => {
    const u = snoozeUntil(`c${c.id}`);
    return u === null ? null : sidebartree.snoozedLabel(u, now(), zone(now()));
  };

  const returned = (id: number): Json[] =>
    h
      .engine()
      .takeQueue(id)
      .map((q) => ({ text: q.text, files: q.files.map((f) => h.uploadId(f)).filter((x): x is string => x !== null) }));

  const action = async (c: Chat, name: string, call: Call): Promise<Reply | null> => {
    const e = h.engine();
    const b = body(call);
    switch (name) {
      case "snooze": {
        if (call.method === "DELETE") {
          setSnooze(`c${c.id}`, null);
          return ok({ ok: true, snoozed_until_ms: null, snoozed_label: null });
        }
        const at = now();
        const off = typeof b.off === "number" && Number.isInteger(b.off) ? b.off : zone(at);
        let until: number;
        if (typeof b.until_ms === "number" && Number.isInteger(b.until_ms)) {
          until = Math.trunc(b.until_ms / 1000);
          if (!(until > at && until <= at + 366 * 86400)) return err(400, "pick a time within the next year");
        } else if (typeof b.text === "string") {
          const u = parseSnooze(b.text, at, off);
          if (u === null) return err(400, "Try 5h, 1h30m, 2d or 18:00");
          until = u;
        } else return err(400, "until_ms or text");
        setSnooze(`c${c.id}`, until);
        return ok({ ok: true, snoozed_until_ms: until * 1000, snoozed_label: label(c) });
      }
      case "main": {
        if (c.repoId === null || !e.repo(c.repoId)) return err(409, "only a chat in a project can be its main chat");
        if (c.role !== "lead") return err(409, "a sub-agent can't be a project's main chat");
        if (c.settled) {
          c.settled = false;
          h.store.saveChat(c);
        }
        e.opened(c.id);
        const all = snoozed();
        if (all.delete(`c${c.id}`)) h.store.set("snoozed", JSON.stringify(Object.fromEntries(all)));
        h.store.setMainChat(c.repoId, c.id);
        e.reload();
        h.hub.touch(null, true);
        const fresh = e.chat(c.id) ?? c;
        return ok({ ok: true, chat: h.phone().chatJson(fresh, call.global) });
      }
      case "stop_all": {
        const out = b.hold === true ? [] : returned(c.id);
        e.stopAll(c.id);
        h.hub.touch(c.id, true);
        return ok({ ok: true, returned: out });
      }
      case "retire":
        try {
          return ok({ ok: true, text: e.retireAgent(c.id) });
        } catch (x) {
          return err(409, x instanceof Error ? x.message : String(x));
        }
      case "fork": {
        if (typeof b.seq !== "number" || !Number.isInteger(b.seq) || b.seq < 0) return err(400, "seq is required");
        if (forkable(e.transcript(c.id).items)[b.seq] == null) return err(409, "only the last reply of a finished turn can be forked");
        const made = e.forkFrom(c.id, b.seq);
        if (made === null) return err(500, "the fork failed");
        h.hub.touch(null, true);
        return ok({ id: call.global ? made.gid : made.id, gid: made.gid });
      }
      case "continue":
        e.limits.continueChat(c.id, true);
        h.hub.touch(c.id, true);
        return ok({ ok: true });
      case "cancel_limit":
        e.limits.cancelLimit(c.id);
        h.hub.touch(c.id, true);
        return ok({ ok: true });
      case "continue_on": {
        const to = typeof b.account === "string" ? b.account : "";
        if (!e.limits.switchTargets(c.id, false).includes(to)) return err(409, "that account can't take this chat now");
        if (!e.limits.continueOn(c.id, to, "is at its usage limit")) return err(409, "couldn't move the chat to that account");
        h.hub.touch(c.id, true);
        return ok({ ok: true });
      }
      case "mention": {
        const q = query(call, "seq");
        const b2 = call.method === "GET" ? { seq: q !== null && /^\d+$/.test(q) ? Number(q) : null, text: null } : { seq: b.seq, text: typeof b.text === "string" ? b.text : null };
        const bad = err(404, call.method === "GET" ? "that message can't be mentioned" : "that message or text can't be mentioned");
        const seq = typeof b2.seq === "number" && Number.isInteger(b2.seq) && b2.seq >= 0 ? b2.seq : null;
        if (seq === null) return bad;
        const items = e.transcript(c.id).items;
        const shown = project(items, false, [])[seq];
        const item = items[seq];
        if (!shown || !item || !actions(shown.card).includes("mention")) return bad;
        const kind = e.account(c.account)?.kind ?? null;
        const whole = mentionOf(item as MentionableItem, seq, mentionAgent({ sub: c.role === "sub", name: c.name }, kind));
        const m = whole === null ? null : b2.text === null ? whole : excerptOf(whole, b2.text);
        return m === null ? bad : ok({ mention: mentionToJson(m) });
      }
      case "clone": {
        const failed = h.projectClones.cloneHere(c, typeof b.path === "string" ? b.path.trim() : "");
        return failed === null ? ok({ ok: true }) : err(409, failed);
      }
      case "run_on":
        if (!h.hub.mesh.on) return err(409, "the PCs aren't sharing chats now: turn the mesh on, or start the chat on that PC");
        return h.projectClones.runOnOwner(c, h.hub.callerLabel(call.token, call.device), call.global);
      case "team":
        return ok(team(c));
      case "slash":
        return call.method === "GET" ? ok(composer.slashChat(c)) : composer.slashCommand(c, call);
      case "tags":
        return ok(await composer.tagsChat(c, call));
      case "move": {
        const r = b.repo !== undefined ? b.repo : b.project_id;
        if (r === undefined) return err(400, 'say the project: {"repo": id, path or null}');
        let repo: number | null;
        if (r === null) repo = null;
        else if (typeof r === "string") {
          const x = e.repos.find((y) => y.path === r.replace(/\/+$/, ""));
          if (!x) return err(404, "no such project");
          repo = x.id;
        } else if (typeof r === "number" && Number.isInteger(r) && e.repo(r)) repo = r;
        else return err(404, "no such project");
        try {
          e.moveChat(c.id, repo);
        } catch (x) {
          return err(409, x instanceof Error ? x.message : String(x));
        }
        h.hub.touch(null, true);
        return ok({ ok: true, chat: h.phone().chatJson(e.chat(c.id) ?? c, call.global), moved: [c.id, ...e.allSubsOf(c.id).map((s) => s.id)] });
      }
      default:
        return null;
    }
  };

  const team = (c: Chat): Json => {
    const e = h.engine();
    const lead = c.role === "sub" ? (c.parent ?? c.id) : c.id;
    const lc = e.chat(lead);
    const repo = lc?.repoId ?? null;
    const home = lc && lc.home !== "" ? h.hub.mesh.nameOf(lc.home) : "";
    const at = Date.now();
    const marks = loadMarks(h.store.get("agent_settle"));
    const subs = e
      .subsOf(lead)
      .sort((a, b) => Number(h.phone().since(a.id) === null) - Number(h.phone().since(b.id) === null) || b.updated - a.updated);
    const agents = subs.map((s) => {
      const acc = e.account(s.account);
      const since = h.phone().since(s.id);
      const paused = e.limits.paused.get(s.id);
      const items = e.transcripts.get(s.id)?.items ?? h.store.items(s.id);
      const usage = cost.ofItems(items);
      const queued = h.phone().queuedCount(s);
      return {
        id: s.id,
        name: s.name,
        title: s.title,
        account: acc ? providers.short(acc) : "",
        model: acc ? e.modelLabel(acc.kind, s.model) : s.model,
        running: since !== null,
        started_ms: since,
        queued,
        paused: paused ? (paused.at !== null ? limits.when(paused.at) : "usage limit") : null,
        settled: agentSettled({ running: since !== null, pending: e.pending.get(s.id)?.length ?? 0, queued: e.queued(s.id).length, paused: paused !== undefined }, marks, s, Math.floor(at / 1000)),
        updated_ms: s.updated * 1000,
        usage: cost.isEmpty(usage) ? null : cost.compact(usage),
      };
    });
    const processes = e.procs.filter((p) => p.lead === lead).map((p) => ({ id: p.id, name: p.name, cmd: p.cmd, url: p.url, started_ms: p.started }));
    const wakeups = e.timers.filter((t) => t.chatId === lead).map((t) => ({ id: t.id, at_ms: t.at * 1000, reason: t.reason }));
    const webhooks = e.webhooks
      .filter((w) => home === "" && w.repoId === repo)
      .map((w) => {
        const [local, pub] = e.hookUrl(w.token);
        return { id: w.id, name: w.name, description: w.description, hits: w.hits, last_ms: w.lastHit * 1000, public: pub !== null, url: pub ?? local };
      });
    return plain({ lead, project_id: repo, home, agents, processes, wakeups, webhooks });
  };

  const gmailInfo = (): Record<string, Json> => ({
    accounts: mcp.googleAccounts("gmail").map((email, i) => ({ email, default: i === 0 })),
    web_client_id: googleWebClientId() ?? null,
    browser: googleDesktopClient("gmail") !== undefined,
  });

  const gmail = async (action: string, b: Record<string, unknown>): Promise<Reply> => {
    const s = (k: string): string => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
    const known = (e: string): boolean => mcp.googleAccounts("gmail").some((x) => x.toLowerCase() === e.toLowerCase());
    let done: Record<string, Json>;
    try {
      switch (action) {
        case "code":
          done = { email: await googlePhoneCode("gmail", s("code")) };
          break;
        case "start": {
          const [url, state] = googlePhoneStart("gmail", s("redirect_uri"));
          done = { url, state };
          break;
        }
        case "finish":
          done = { email: await googlePhoneFinish("gmail", s("state"), s("code")) };
          break;
        case "default":
        case "signout":
          if (!known(s("email"))) throw new Error("That account isn't connected here.");
          if (action === "default") mcp.setGoogleDefault("gmail", s("email"));
          else mcp.signOutAccount("gmail", s("email"));
          done = {};
          break;
        default:
          return err(404, "no such call");
      }
    } catch (x) {
      return err(409, x instanceof Error ? x.message : String(x));
    }
    return ok({ ...done, ...gmailInfo() });
  };

  /** Discord's status as the phone shows it: the desktop card's line, and the sign-in's QR drawn as rows. */
  const discordInfo = async (): Promise<Json> => {
    const raw = await discord.status();
    const s = plain(raw) as Record<string, Json>;
    const url = (s.signin as Record<string, Json> | null)?.qr;
    const qr = typeof url === "string" && url !== "" ? ((await qrRows(url)) ?? null) : null;
    return { ...s, qr, card: discord.cardLine(raw, mcp.app("discord")?.about ?? "") };
  };

  const discordCaptcha = async (action: string, b: Record<string, unknown>): Promise<Reply> => {
    if (action === "captcha_cancel") await discord.captchaCancel();
    else {
      const kind = b.kind;
      if ((kind !== "down" && kind !== "up" && kind !== "move") || typeof b.x !== "number" || typeof b.y !== "number") return err(400, "kind (down, up or move), x and y");
      await discord.captchaInput(kind, b.x, b.y);
    }
    return ok({});
  };

  const discordCall = async (action: string, b: Record<string, unknown>): Promise<Reply> => {
    if (action === "captcha_input" || action === "captcha_cancel") return discordCaptcha(action, b);
    try {
      switch (action) {
        case "signin":
          if (b.accept !== true) throw new Error("Sign-in needs the warning accepted first.");
          await discord.signin();
          break;
        case "window":
          await discord.window();
          break;
        case "cancel":
          await discord.cancel();
          break;
        case "signout":
          discord.signOut();
          break;
        default:
          return err(404, "no such call");
      }
    } catch (x) {
      return err(409, x instanceof Error ? x.message : String(x));
    }
    return ok(await discordInfo());
  };

  /** WhatsApp's link on this PC as the phone shows it: the desktop card's line, and a running link's QR drawn as rows and its code. */
  const whatsappInfo = async (): Promise<Json> => {
    const raw = await whatsapp.status();
    const s = plain(raw) as Record<string, Json>;
    const url = (s.pairing as Record<string, Json> | null)?.qr;
    const qr = typeof url === "string" && url !== "" ? ((await qrRows(url)) ?? null) : null;
    return { ...s, qr, card: whatsapp.cardLine(raw, mcp.app("whatsapp")?.about ?? "") };
  };

  const whatsappCall = async (action: string, b: Record<string, unknown>): Promise<Reply> => {
    const phone = typeof b.phone === "string" ? b.phone.trim() : "";
    try {
      switch (action) {
        case "link":
          if (b.accept !== true) throw new Error("Linking needs the warning accepted first.");
          await whatsapp.link(phone === "" ? undefined : phone);
          break;
        case "code": {
          if (phone === "") throw new Error("Pass the phone number.");
          // The phone waits 25 s at most: a slower code (a first install, Brazil's second form)
          // still comes, in the sheet's next look ("Getting a code…" until then).
          const asked = whatsapp.code(phone);
          asked.catch(() => {});
          await Promise.race([asked, new Promise((r) => setTimeout(r, 20_000))]);
          break;
        }
        case "uncode":
          await whatsapp.uncode();
          break;
        case "cancel":
          await whatsapp.cancel();
          break;
        case "signout":
          await whatsapp.unlink();
          break;
        default:
          return err(404, "no such call");
      }
    } catch (x) {
      return err(409, x instanceof Error ? x.message : String(x));
    }
    return ok(await whatsappInfo());
  };

  const commit = async (c: Chat, sha: string, withDiff: boolean): Promise<Reply> => {
    const e = h.engine();
    const repo = e.repo(c.repoId);
    if (c.device !== "" || !repo) return err(404, "this chat has no project on this PC");
    const own = repoDir(repo);
    const wt = c.home === "" ? e.worktreeOf(c) : null;
    const dir = wt !== null && existsSync(wt) && statSync(wt).isDirectory() ? wt : own;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return err(404, "this chat has no project on this PC");
    try {
      const d = await commits.detail(dir, sha);
      const v = commits.detailJson(d) as Record<string, Json>;
      if (withDiff) {
        const text = await commits.diff(dir, d.commit.sha).catch(() => null);
        const lines = text === null ? { lines: [] as Json[] } : (ghapi.diffJson(prdetail.parseDiff, text) as Record<string, Json>);
        v.lines = lines.lines ?? [];
        v.clipped = lines.clipped ?? null;
      }
      return ok(plain(v));
    } catch (x) {
      return err(404, x instanceof Error ? x.message : String(x));
    }
  };

  const moveTargets = async (c: Chat): Promise<Json> => {
    const e = h.engine();
    const subs = e.allSubsOf(c.id);
    const blocker = movePcBlocker({
      foreignHome: c.home !== "" ? h.hub.mesh.nameOf(c.home) : null,
      isSub: c.role === "sub",
      meshOn: h.hub.mesh.on,
      movingTo: null,
      chats: [c, ...subs].map((x) => ({ id: x.id, name: x.name, device: x.device, claude: e.account(x.account)?.kind === "Claude", running: h.phone().since(x.id) !== null })),
    });
    const hosts = [...h.hub.mesh.peers.values()].sort((a, b) => Number(b.online) - Number(a.online) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const targets = movePcTargets({ blocker, meId: h.hub.mesh.me.id, hosts, allowedFp: (fp) => h.hub.mesh.usableFp(fp) !== null, downOf: (id) => h.hub.mesh.down.get(id) ?? null });
    let codeError: string | null = null;
    if (blocker === null && c.repoId !== null && c.device === "") {
      try {
        await codeState({ home: homedir() }, e.chatCwd(c), e.worktreeOf(c) !== null);
      } catch (x) {
        codeError = x instanceof Error ? x.message : String(x);
      }
    }
    return plain(apiMoveTargets(blocker, targets, codeError));
  };

  const targetOf = (call: Call): Target | Reply => {
    const ref = query(call, "chat");
    return ref !== null && ref !== "" ? chatTarget(ref) : { t: "draft", repo: composer.repoRef(query(call, "project") ?? "") };
  };
  const chatTarget = (ref: string): Target | Reply => {
    const c = resolve(ref);
    return c ? { t: "chat", id: c.id } : err(404, "no such chat");
  };
  const isReply = (t: Target | Reply): t is Reply => "status" in t;
  const headLine = async (dir: string): Promise<string> => {
    const hd = await wt.head(dir);
    return hd ? wt.headLabel(hd) : "";
  };

  const workspaceInfo = async (call: Call): Promise<Reply> => {
    const target = targetOf(call);
    if (isReply(target)) return target;
    if (target.t === "chat") h.wantPr(target.id);
    const info = h.worktrees.info(target);
    if (!info) return ok({ git: false });
    const newWorktree = target.t === "draft" && query(call, "worktree") === "1";
    const base = query(call, "base") ?? "";
    const c = target.t === "chat" ? h.engine().chat(target.id) : undefined;
    const lead = c ? (c.role === "sub" ? (c.parent ?? c.id) : c.id) : null;
    const to = lead === null ? null : h.worktrees.folderTo(lead);
    const waits = lead !== null && to !== null ? h.worktrees.folderBusy(lead) : null;
    const hd = await wt.head(info.dir);
    const folderRename = info.rename === null;
    const rename = info.rename !== null ? info.rename : hd !== null && hd.branch === "" ? "it's detached: switch to a branch first" : null;
    const pushed = rename === null ? await wt.pushedAs(info.dir) : null;
    return ok({
      git: true,
      mode: info.worktree !== null || newWorktree ? "worktree" : "checkout",
      name: info.worktree === null ? null : basename(info.worktree),
      path: info.worktree ?? info.repo,
      branch: hd ? wt.headLabel(hd) : "",
      dirty: hd?.dirty ?? 0,
      base: newWorktree ? (base === "" ? (hd?.branch ?? "") : base) : "",
      can_move: info.canMove === null,
      move_why: info.canMove,
      branch_lock: newWorktree ? null : info.branchLock,
      pending: h.worktrees.busy?.what ?? null,
      can_rename: rename === null,
      can_rename_folder: folderRename,
      rename_why: rename,
      pushed,
      folder_waits: waits,
      folder_to: to,
      folder_named: lead !== null && h.worktrees.folderNamed(lead),
    });
  };

  const branchList = async (call: Call): Promise<Reply> => {
    const target = targetOf(call);
    if (isReply(target)) return target;
    const info = h.worktrees.info(target);
    if (!info) return err(409, "not a git project");
    const q = (query(call, "q") ?? "").trim();
    let b: wt.Branches;
    try {
      b = await wt.branches(info.dir);
    } catch (x) {
      return err(409, x instanceof Error ? x.message : String(x));
    }
    const hd = (await wt.head(info.dir)) ?? { branch: "", detached: "", dirty: 0 };
    const rows = wt.rank(b, q, 100);
    return ok({
      current: hd.branch,
      dirty: hd.dirty,
      warning: hd.dirty > 0 ? `${hd.dirty} uncommitted change${hd.dirty === 1 ? "" : "s"} here: they come along to the branch you switch to, and git refuses if they'd be overwritten.` : null,
      checkout_note: info.worktree === null ? "Switches the project's checkout (other threads there see it too)" : null,
      branches: rows.map((r) => ({ name: r.name, remote: r.remote, current: !r.remote && r.name === hd.branch })),
      can_create: q !== "" && !b.local.includes(q) && (await wt.validBranch(info.dir, q)),
      branch_lock: info.branchLock,
    });
  };

  const switchBranch = async (call: Call): Promise<Reply> => {
    const b = body(call);
    const id = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
    const chatRef = id(b.chat);
    const target: Target | Reply = chatRef !== null && chatRef !== "" ? chatTarget(chatRef) : { t: "draft", repo: composer.repoRef(id(b.project) ?? "") };
    if (isReply(target)) return target;
    const row = typeof b.switch === "string" ? { name: b.switch, remote: b.remote === true } : null;
    const create = row === null && typeof b.create === "string" ? b.create : null;
    if (row === null && create === null) return err(400, "switch or create a branch");
    try {
      await h.worktrees.branch(target, row, create);
    } catch (x) {
      return err(409, x instanceof Error ? x.message : String(x));
    }
    const info = h.worktrees.info(target);
    return ok({ ok: true, branch: info ? await headLine(info.dir) : "" });
  };

  const people = (): Json => {
    const e = h.engine();
    const own = h.versionsOwn();
    const input = versionsInput(h.hub, own);
    const [versions] = gatherVersions(input);
    const hosts = [...h.hub.mesh.peers.values()].sort((a, b) => Number(b.online) - Number(a.online) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const pcs = meshPcs({
      kv: h.store,
      owners: h.owners,
      me: h.hub.mesh.me,
      hostname: own.hostname,
      meshOn: h.hub.mesh.on,
      localPhones: h.hub.localPhones().map((p) => ({ name: p.name, app: p.app })),
      versions,
      accounts: e.host.accounts().filter((a) => a.bin !== null).map((a) => providers.short(a)),
      hosts,
      elsewhere: h.hub.elsewhere,
    });
    return plain(
      apiPeople(h.store, h.owners, {
        pcs,
        share: (id) => {
          const l = machines.levelFor(h.store, id);
          return { slug: l, label: machines.short(l) };
        },
        levels: machines.LEVELS.map((l) => ({ id: l, label: machines.label(l), about: machines.aboutLevel(l) })),
        detecting: h.profile.running || h.profile.want,
        check: h.profileCheck(),
        shareGithub: machines.githubOn(h.store),
      }),
    );
  };

  return async (call, chat) => {
    const p = call.path;
    const m = call.method;
    const name = p[3] ?? "";
    if (p[0] === "v1" && p[1] === "chats" && chat !== null && p.length === 5 && m === "GET" && p[3] === "commit") return commit(chat, p[4] ?? "", query(call, "diff") === "1");
    if (p[0] === "v1" && p[1] === "chats" && chat !== null && m === "POST" && p[3] === "worktree" && p.length === 4) {
      try {
        const dir = await h.worktrees.moveToWorktree(chat.id);
        return ok({ ok: true, name: basename(dir), path: dir });
      } catch (x) {
        return err(409, x instanceof Error ? x.message : String(x));
      }
    }
    if (p[0] === "v1" && p[1] === "chats" && chat !== null && m === "POST" && p[3] === "worktree" && p[4] === "rename" && p.length === 5) {
      const b = body(call);
      try {
        if (typeof b.folder === "string") {
          const d = h.worktrees.renameFolder(chat.id, b.folder);
          return ok({ ok: true, name: d.folder, path: d.path, folder_waits: d.waits, said: wt.renameSaid(d) });
        }
        if (typeof b.branch !== "string") return err(400, "branch or folder: the new name");
        const d = await h.worktrees.renameBranch(chat.id, b.branch, b.remote !== false, true);
        return ok({ ok: true, branch: d.renamed.branch, old: d.renamed.old, remote: d.renamed.remote, name: d.folder, path: d.path, folder_waits: d.waits, said: wt.renameSaid(d) });
      } catch (x) {
        return err(409, x instanceof Error ? x.message : String(x));
      }
    }
    if (p[0] === "v1" && p[1] === "chats" && chat !== null && p.length === 4) {
      const moved = ["workspace", "workspaces", "share", "shares"].includes(name) && h.moves ? await h.moves.route(call, chat) : null;
      if (moved) return moved;
      // The chat's Discord captcha card (frame, pointer, Don't join): only where the chat's content may go.
      if (m === "POST" && name === "captcha") {
        if (chat.home !== "") return err(404, `This chat's captcha is on ${h.hub.mesh.nameOf(chat.home)}.`);
        const r = await discord.chatCaptcha(chat.id, body(call));
        return r.status === 200 ? ok(plain(r.body)) : err(r.status, String((r.body as { error?: unknown } | null)?.error ?? "no captcha"));
      }
      if ((m === "POST" && ["main", "stop_all", "retire", "fork", "continue", "cancel_limit", "continue_on", "snooze", "mention", "slash", "move", "clone", "run_on"].includes(name)) || (m === "DELETE" && name === "snooze")) return action(chat, name, call);
      if (m === "GET" && ["mention", "team", "slash", "tags"].includes(name)) return action(chat, name, call);
      if (m === "GET" && name === "move_targets") return ok(await moveTargets(chat));
      return null;
    }
    if (p[0] !== "v1") return null;
    if (p.length === 3 && p[1] === "palette" && p[2] === "run" && m === "POST") {
      const ref = typeof body(call).chat === "number" ? String(body(call).chat) : typeof body(call).chat === "string" ? (body(call).chat as string) : null;
      return composer.paletteRun(call, ref === null ? null : (resolve(ref)?.id ?? null));
    }
    if (p[1] === "apps" && p.length === 3 && m === "GET") {
      if (p[2] === "gmail") return ok(gmailInfo());
      if (p[2] === "discord") return ok(await discordInfo());
      if (p[2] === "whatsapp") return ok(await whatsappInfo());
    }
    if (p[1] === "apps" && p[2] === "discord" && p[3] === "captcha" && p.length === 4 && m === "GET") {
      const f = await discord.captchaFrame();
      return f === undefined ? err(404, "No captcha is waiting.") : ok(plain(f));
    }
    if (p[1] === "apps" && p.length === 4 && m === "POST") {
      if (p[2] === "gmail") return gmail(p[3] ?? "", body(call));
      if (p[2] === "discord") return discordCall(p[3] ?? "", body(call));
      if (p[2] === "whatsapp") return whatsappCall(p[3] ?? "", body(call));
    }
    if (p[1] === "projects") return h.projects.route(call);
    if (p[1] === "worktrees" && p[2] === "settings" && p.length === 3) {
      // Delete merged worktrees (worktreeclean.ts), as the desktop's General tab sets it; account settings, synced.
      if (m === "PUT") {
        const b = body(call);
        for (const [k, key] of [["delete_merged", WT_CLEAN.worktree], ["delete_branch", WT_CLEAN.branch], ["delete_remote", WT_CLEAN.remote]] as const) if (typeof b[k] === "boolean") h.store.set(key, b[k] ? "1" : "0");
      } else if (m !== "GET") return null;
      const pr = wtclean.prefsOf(h.store);
      return ok({ delete_merged: pr.worktree, delete_branch: pr.branch, delete_remote: pr.remote });
    }
    if (p.length !== 2) return null;
    if (m === "GET" && p[1] === "workspace") return workspaceInfo(call);
    if (m === "GET" && p[1] === "branches") return branchList(call);
    if (m === "POST" && p[1] === "branches") return switchBranch(call);
    if (m === "GET" && p[1] === "slash") return ok(composer.slashDraft(call));
    if (m === "GET" && p[1] === "tags") return ok(await composer.tagsDraft(call));
    if (m === "GET" && p[1] === "palette") {
      const ref = query(call, "chat");
      return ok(composer.palette(call, ref === null ? null : (resolve(ref)?.id ?? null)));
    }
    if (m === "GET" && p[1] === "people") return ok(people());
    if (m === "PATCH" && p[1] === "people") {
      apiPeopleSet(h.store, call.body, {
        confirm: () => confirmOwner(h.store, h.owners),
        detect: () => {
          h.profile.want = true;
        },
        hasPeer: (id) => h.hub.mesh.peer(id) !== undefined,
        setShare: (pc, level) => {
          const l = machines.parseLevel(level);
          if (l !== null) machines.setLevel(h.store, pc, l);
        },
        levelOk: (level) => machines.parseLevel(level) !== null,
        setShareGithub: (on) => h.store.set(machines.GITHUB_KEY, on ? "1" : "0"),
        republish: () => h.republish(),
      });
      return ok(people());
    }
    if (m === "GET" && p[1] === "versions") return ok(versionsJson(versionsInput(h.hub, h.versionsOwn())));
    if (m === "GET" && p[1] === "usage") {
      const e = h.engine();
      const names = new Map(h.store.repos().map((r) => [r.id, r.name]));
      const chats = new Map(h.store.chats().map((c): [number, [string, string]] => [c.id, [c.account, c.repoId === null ? "" : (names.get(c.repoId) ?? "")]]));
      const today = Math.floor(now() / 86400);
      const totals = cost.sumResults(h.store.results(), chats, today);
      const at = now();
      return ok(JSON.parse(JSON.stringify({ ...cost.apiUsage(totals, today, (id) => e.accountLabel(id)), limits: e.usageReadings().map((r) => usageCtl.readingJson(r, at)) })) as Json);
    }
    if (m === "GET" && p[1] === "snooze") {
      const at = now();
      const off = Number.parseInt(query(call, "off") ?? "", 10);
      const o = Number.isFinite(off) ? off : zone(at);
      const text = query(call, "text") ?? "";
      const [until, preview] = snoozePreview(text, at, o);
      const ref = query(call, "chat");
      const chat = ref === null ? null : resolve(ref);
      const u = chat === null ? null : snoozeUntil(`c${chat.id}`);
      return ok({
        presets: snoozePresets(at, o).map(([l, t]) => ({ label: l, until_ms: t * 1000 })),
        text,
        until_ms: until === null ? null : until * 1000,
        preview,
        snoozed: u === null ? null : `until ${sidebartree.snoozeLabel(u, at, o)}`,
      });
    }
    return null;
  };
}
