import { homedir } from "node:os";
import { type Call, err, type Json, loadRemote, ok, type PhoneRoutes, type Reply } from "./packages/net/src/index.ts";
import { type Chat, type Repo, repoDir, type Store } from "./packages/store/src/index.ts";
import { type Engine, git, providers } from "./packages/agents/src/index.ts";
import { forkable } from "./packages/agents/src/fork.ts";
import { githubRepo } from "./packages/mcp/src/github/prs.ts";
import * as chatmention from "./packages/ui/src/logic/chatmention.ts";
import * as palette from "./packages/ui/src/logic/palette.ts";
import * as slash from "./packages/ui/src/logic/slash.ts";
import * as tags from "./packages/ui/src/logic/tags.ts";

export interface ComposerHost {
  store: Store;
  engine: () => Engine;
  phone: () => PhoneRoutes;
  homeName(c: Chat): string;
  touch(): void;
}

interface Probe {
  at: number;
  entries: slash.Entry[] | null;
}

interface Cached<T> {
  at: number;
  items: T[] | null;
  loading: boolean;
}

const query = (c: Call, k: string): string | null => c.query.find(([q]) => q === k)?.[1] ?? null;
const body = (c: Call): Record<string, unknown> => (typeof c.body === "object" && c.body !== null && !Array.isArray(c.body) ? (c.body as Record<string, unknown>) : {});
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

export function composerRoutes(h: ComposerHost) {
  const probes = new Map<string, Probe>();
  const files = new Map<string, Cached<string>>();
  const refs = new Map<string, Cached<tags.Ref>>();
  const beforePlan = new Map<number, string>();

  const cwdOf = (repo: number | null): string => h.engine().cwdOf(repo);
  const repoRef = (r: string): number | null => {
    const e = h.engine();
    if (/^-?\d+$/.test(r)) return e.repo(Number(r))?.id ?? null;
    return e.repos.find((x) => x.path === r)?.id ?? null;
  };

  const lastForkable = (chat: number): number | null => {
    const items = h.engine().transcripts.get(chat)?.items;
    if (!items) return null;
    const f = forkable(items);
    for (let i = f.length - 1; i >= 0; i--) if (f[i] != null) return i;
    return null;
  };

  interface Target {
    kind: string;
    remote: boolean;
    access: string;
    account: providers.Account | undefined;
    cwd: string;
    personal: string;
    chat: slash.SlashChat | null;
  }

  const targetFor = (account: string, device: string, access: string, repo: number | null, chat: number | null): Target => {
    const e = h.engine();
    const acc = e.account(account);
    const kind = acc?.kind ?? "Claude";
    const c = chat === null ? undefined : e.chat(chat);
    return {
      kind,
      remote: device !== "",
      access,
      account: acc,
      cwd: cwdOf(repo),
      personal: slash.personalDir(acc ? { kind: acc.kind.toLowerCase(), configDir: acc.configDir } : null, homedir()),
      chat: c ? { forkable: lastForkable(c.id) !== null, settled: c.settled, queued: e.queued(c.id).length > 0 } : null,
    };
  };

  const claudeInstalled = (t: Target): providers.Account | undefined => (t.account && t.account.kind === "Claude" && t.account.bin !== null ? t.account : undefined);

  const refreshSlash = (t: Target): void => {
    const a = claudeInstalled(t);
    if (!a) return;
    const key = `${a.id}\0${t.cwd}`;
    const known = probes.get(key);
    if (known && Date.now() - known.at < slash.STALE_MS) return;
    probes.set(key, { at: Date.now(), entries: known?.entries ?? null });
    void slash.probe(providers.binStr(a), t.cwd, Object.fromEntries(providers.accountEnv(a))).then((list) => {
      const p = probes.get(key);
      if (list !== null && p) {
        p.entries = list;
        h.touch();
      }
    });
  };

  const slashFor = (t: Target): Json => {
    refreshSlash(t);
    const a = claudeInstalled(t);
    const p = a ? probes.get(`${a.id}\0${t.cwd}`) : undefined;
    const pending = p !== undefined && p.entries === null && Date.now() - p.at < slash.PROBE_TIMEOUT_MS;
    const kind = t.kind as providers.Kind;
    const list = slash.entries(
      { efforts: providers.efforts(kind).map((c) => c[0]), access: providers.access(kind).map((c) => c[0]) },
      t.remote,
      t.access,
      t.chat,
      t.kind === "Claude" ? (p?.entries ?? null) : null,
      slash.scan(`${t.cwd}/.claude`),
      slash.scan(t.personal),
    );
    return { entries: list.map((e) => plain(slash.entryJson(e))), pending };
  };

  const cached = <T>(map: Map<string, Cached<T>>, key: string, ttl: number, load: () => Promise<T[] | null> | T[] | null): { items: T[] | null; pending: boolean } => {
    const c = map.get(key);
    if (!c || (!c.loading && Date.now() - c.at >= ttl)) {
      const entry: Cached<T> = { at: Date.now(), items: c?.items ?? null, loading: true };
      map.set(key, entry);
      void Promise.resolve()
        .then(load)
        .then(
          (items) => {
            entry.items = items ?? entry.items;
            entry.loading = false;
            entry.at = Date.now();
          },
          () => {
            entry.loading = false;
          },
        );
    }
    const now = map.get(key);
    return { items: now?.items ?? null, pending: now?.items === null || now === undefined };
  };

  const githubOf = async (repo: Repo | undefined): Promise<string | null> => {
    if (!repo) return null;
    const remote = repo.remote !== "" ? repo.remote : ((await git.origin(repoDir(repo))) ?? "");
    return remote === "" ? null : (githubRepo(remote) ?? null);
  };

  const tagsIn = async (repo: number | null, trigger: string, q: string): Promise<Json> => {
    const t = tags.apiTrigger(trigger);
    const e = h.engine();
    let rows: tags.TagRow[] = [];
    let pending = false;
    if (t === "@") {
      if (repo !== null && e.repo(repo)) {
        const cwd = cwdOf(repo);
        const c = cached(files, cwd, tags.FILES_STALE_MS, () => tags.listFiles(cwd));
        pending = c.pending;
        rows = tags.rows("@", q, c.items, null);
      }
    } else {
      const gh = await githubOf(e.repo(repo));
      if (gh !== null) {
        const c = cached(refs, gh, tags.REFS_STALE_MS, () => tags.fetchRefs(gh));
        pending = c.pending;
        rows = tags.rows("#", q, null, c.items);
      }
    }
    return { items: rows.map((r) => plain(tags.rowJson(r))), pending };
  };

  const candChats = (): chatmention.CandChat[] => {
    const e = h.engine();
    return e.chats.map((c) => ({
      id: c.id,
      gid: c.gid,
      title: c.title,
      repoId: c.repoId,
      sub: c.role === "sub",
      settled: c.settled,
      updated: c.updated,
      running: h.phone().since(c.id) !== null,
      project: e.repo(c.repoId)?.name ?? "",
      pc: h.homeName(c),
    }));
  };
  const chatRows = (key: number, repo: number | null, q: string): Json => ({ items: chatmention.chatRows(candChats(), key, repo, q).map((c) => plain(chatmention.candJson(c))), pending: false });

  const recent = (): string[] => {
    try {
      const v: unknown = JSON.parse(h.store.get(palette.RECENT_KEY) ?? "");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };

  const paletteItems = (current: number | null): palette.Item[] => {
    const e = h.engine();
    return palette.paletteItems({
      repos: e.repos.map((r) => ({ id: r.id, name: r.name, dir: tilde(repoDir(r)) })),
      chats: e.chats.map((c) => ({ id: c.id, title: c.title, role: c.role, parent: c.parent, name: c.name, repoId: c.repoId, settled: c.settled, updated: c.updated })),
      devices: loadRemote(h.store).devices.map((d) => ({ id: d.id, name: d.name })),
      current,
      draftRepo: null,
      fast: e.fast,
      forkable: current !== null && lastForkable(current) !== null,
    });
  };

  const tilde = (p: string): string => {
    const home = homedir();
    return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  };

  const settle = (c: Chat, on: boolean): void => {
    c.settled = on;
    h.store.saveChat(c);
    h.engine().reload();
    h.engine().opened(c.id);
    h.touch();
  };

  const forkNow = (chat: number, seq: number): Chat | null => {
    const made = h.engine().forkFrom(chat, seq);
    if (made !== null) h.touch();
    return made;
  };

  return {
    lastForkable,
    settle,
    forkNow,
    repoRef,
    slashChat: (c: Chat): Json => slashFor(targetFor(c.account, c.device, c.access, c.repoId, c.id)),
    slashDraft: (call: Call): Json => {
      const e = h.engine();
      const account = query(call, "account") ?? "";
      const t = targetFor(e.account(account) ? account : "claude", query(call, "device") ?? "", query(call, "access") ?? "", repoRef(query(call, "project") ?? ""), null);
      return slashFor(t);
    },
    slashCommand: async (c: Chat, call: Call): Promise<Reply> => {
      const e = h.engine();
      const r = slash.apiCommand(body(call).command);
      if ("error" in r) return err(r.status, r.error);
      switch (r.command) {
        case "fork": {
          const seq = lastForkable(c.id);
          if (seq === null) return err(409, "this chat has no finished reply to fork after");
          const made = forkNow(c.id, seq);
          return made === null ? err(500, "the fork failed") : ok({ ok: true, id: call.global ? made.gid : made.id, gid: made.gid });
        }
        case "settle":
          settle(c, true);
          return ok({ ok: true, chat: h.phone().chatJson(e.chat(c.id) ?? c, call.global) });
        case "clear-queue":
          return ok({ ok: true, dropped: e.takeQueue(c.id).length });
        default: {
          const kind = (e.account(c.account)?.kind ?? "Claude") as providers.Kind;
          const before = r.command === "plan" ? null : (beforePlan.get(c.id) ?? null);
          if (r.command !== "plan") beforePlan.delete(c.id);
          const access = slash.accessAfter(r.command === "plan" ? "plan" : "default", { efforts: [], access: providers.access(kind).map((x) => x[0]) }, before);
          const patched = await h.phone().route({ method: "PATCH", path: ["v1", "chats", String(c.id)], query: [], body: { access }, token: call.token, device: call.device, global: call.global });
          if (patched.status >= 300) return patched;
          if (r.command === "plan" && c.access !== "plan") beforePlan.set(c.id, c.access);
          return ok({ ok: true, chat: h.phone().chatJson(e.chat(c.id) ?? c, call.global) });
        }
      }
    },
    tagsDraft: async (call: Call): Promise<Json> => {
      const repo = repoRef(query(call, "project") ?? "");
      return query(call, "trigger") === "$" ? chatRows(-1, repo, query(call, "q") ?? "") : tagsIn(repo, query(call, "trigger") ?? "@", query(call, "q") ?? "");
    },
    tagsChat: async (c: Chat, call: Call): Promise<Json> =>
      query(call, "trigger") === "$" ? chatRows(c.id, c.repoId, query(call, "q") ?? "") : tagsIn(c.repoId, query(call, "trigger") ?? "@", query(call, "q") ?? ""),
    palette: (call: Call, chat: number | null): Json => plain(palette.paletteJson(paletteItems(chat), query(call, "q") ?? "", recent())),
    paletteRun: async (call: Call, chat: number | null): Promise<Reply> => {
      const e = h.engine();
      const b = body(call);
      if (typeof b.id !== "string") return err(400, "id is required");
      const it = paletteItems(chat).find((x) => x.id === b.id);
      if (!it) return err(404, "no such item (any more)");
      if (palette.actWire(it.act) === null) return err(400, "not on the phone");
      h.store.set(palette.RECENT_KEY, JSON.stringify(palette.remember(recent(), b.id)));
      let open: Chat | null = null;
      const a = it.act;
      if (a.kind === "settle") {
        const c = e.chat(a.id);
        if (c) settle(c, a.on);
      } else if (a.kind === "fork") {
        const seq = lastForkable(a.id);
        if (seq !== null) open = forkNow(a.id, seq);
        if (open === null) return err(409, "this chat has no finished reply to fork after");
      } else if (a.kind === "fast") {
        e.fast = a.on;
        h.store.set("fast_mode", a.on ? "1" : "0");
        h.touch();
      }
      const said = a.kind === "settle" ? (a.on ? "Settled" : "Back from settled") : a.kind === "fast" ? (a.on ? "Fast mode on" : "Fast mode off") : "";
      return ok({ ok: true, open: open === null ? null : call.global ? open.gid : open.id, gid: open === null ? null : open.gid, toast: said });
    },
  };
}
