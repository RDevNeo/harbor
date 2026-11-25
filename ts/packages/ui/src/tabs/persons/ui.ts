// Persons tab, window side: drives PersonsBus (slint/persons.slint) from the engine's v1/persons routes (in-process
// through ctx.call — the same routes Hub for Android uses). Pictures are local files the engine cached, decoded here.
import * as slint from "slint-ui";
import { readFileSync, statSync } from "node:fs";
import { images } from "@harbor/media";
import type { TabCtx, TabUi } from "../api.ts";
import { syncRows } from "../../modelsync.ts";
import { loadQr } from "../../qr.ts";
import { chatRows, listRows, sideRows, type ChatJson, type MsgRow, type PersonJson, type Row, type StateJson, type UiState } from "./view.ts";

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
const NO_PX: Pixels = { width: 1, height: 1, data: new Uint8ClampedArray(4) };

type Cb = (...a: never[]) => unknown;
interface Bus extends Record<string, unknown> {
  [k: string]: unknown;
}

interface PanelJson {
  person: Record<string, unknown> & { id: string; notes?: string; settled?: Record<string, string>; storeIds: string[]; listIds: string[]; socials?: string[]; discordId?: string; discordUsername?: string; email?: string; whatsapp?: string; name: string };
  name: string;
  initials: string;
  color: string;
  avatarPath: string | null;
  stores: { id: string; name: string; owner: boolean; color: string }[];
  lists: { id: string; name: string }[];
  identities: { kind: string; value: string; section: string | null; label: string }[];
  socials: { url: string; platform: string | null; handle: string | null; note?: string; uploads: { title: string; url: string; thumb: string | null; meta?: string }[] }[];
}

const SECTION_LABEL: Record<string, string> = { stores: "Stores", creators: "Creators", spokpay: "SpokPay" };
const KIND_LABEL: Record<string, string> = { discord: "Discord", gmail: "Gmail", whatsapp: "WhatsApp" };
const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#8b5cf6", "#0ea5e9"];

/** Decoded pictures by file (and size class), shared by every row that draws them. */
class Pictures {
  private done = new Map<string, { mtime: number; px: Pixels | null }>();
  private busy = new Set<string>();
  constructor(private readonly changed: () => void) {}

  get(path: string | null | undefined, cap = 96): Pixels | null {
    if (!path) return null;
    const key = `${cap}:${path}`;
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return null;
    }
    const hit = this.done.get(key);
    if (hit && hit.mtime === mtime) return hit.px;
    if (!this.busy.has(key)) {
      this.busy.add(key);
      void images
        .decodeBytes(new Uint8Array(readFileSync(path)), cap)
        .then(
          (r) => this.done.set(key, { mtime, px: r.image as Pixels }),
          () => this.done.set(key, { mtime, px: null }),
        )
        .finally(() => {
          this.busy.delete(key);
          this.changed();
        });
    }
    return hit?.px ?? null;
  }
}

class PersonsTab {
  private bus: Bus;
  private state: StateJson | null = null;
  private ui: UiState = { closed: new Set(), stores: new Set(), settledOpen: new Set(), open: null, allActive: true };
  private query = "";
  private chat: ChatJson | null = null;
  private panelData: PanelJson | null = null;
  private panelOpen = true;
  private aiMode = false;
  private replyTo: { id: string; text: string } | null = null;
  private menuActions = new Map<string, () => void>();
  private dialogOk: (() => Promise<void> | void) | null = null;
  private chipState = new Map<string, boolean>();
  private colorPick = "";
  private typingAt = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private toastAction: (() => void) | null = null;
  private pics: Pictures;
  private sideModel = new slint.ArrayModel<Record<string, unknown>>([]);
  private listModel = new slint.ArrayModel<Record<string, unknown>>([]);
  private msgModel = new slint.ArrayModel<Record<string, unknown>>([]);
  private renderQueued = false;
  private chatSeq = 0;
  private qr: ((text: string) => Pixels) | null = null;
  private alive = true;

  constructor(private readonly ctx: TabCtx) {
    this.bus = Reflect.get(ctx.win, "PersonsBus") as Bus;
    this.pics = new Pictures(() => this.render());
    const b = this.bus;
    b.side = this.sideModel;
    b.list = this.listModel;
    b.msgs = this.msgModel;
    const on = (name: string, f: Cb): void => {
      b[name] = f;
    };
    on("all_people", () => {
      this.ui.open = null;
      this.ui.allActive = true;
      this.chat = null;
      this.render();
    });
    on("open_person", ((id: string, section: string, store: string) => void this.openPerson(id, section, store)) as Cb);
    on("toggle_store", ((id: string) => this.toggle(this.ui.stores, id)) as Cb);
    on("toggle_section", ((sec: string) => (sec.startsWith("settled:") ? this.toggle(this.ui.settledOpen, sec.slice(8)) : this.toggle(this.ui.closed, sec))) as Cb);
    on("section_menu", ((sec: string, x: number, y: number) => this.sectionMenu(sec, x, y)) as Cb);
    on("row_menu", ((id: string, sec: string, store: string, x: number, y: number) => this.rowMenu(id, sec, store, x, y)) as Cb);
    on("store_menu", ((id: string, x: number, y: number) => this.storeMenu(id, x, y)) as Cb);
    on("edited_query", ((q: string) => {
      this.query = q;
      this.render();
    }) as Cb);
    on("close_chat", () => {
      this.ui.open = null;
      this.chat = null;
      this.render();
    });
    on("send", () => void this.send());
    on("typing", () => this.typing());
    on("older", () => void this.older());
    on("toggle_panel", () => {
      this.panelOpen = !this.panelOpen;
      if (this.panelOpen) void this.loadPanel();
      this.render();
    });
    on("account_menu", ((x: number, y: number) => this.accountMenu(x, y)) as Cb);
    on("msg_menu", ((id: string, x: number, y: number) => this.msgMenu(id, x, y)) as Cb);
    on("open_file", ((id: string) => void this.openFile(id)) as Cb);
    on("cancel_reply", () => {
      this.replyTo = null;
      this.render();
    });
    on("toggle_ai", () => {
      this.aiMode = !this.aiMode;
      this.render();
    });
    on("save_notes", ((text: string) => void this.saveNotes(text)) as Cb);
    on("open_url", ((url: string) => ctx.openExternal(url)) as Cb);
    on("menu_pick", ((id: string) => this.pick(id)) as Cb);
    on("menu_close", () => {
      b.menu_open = false;
    });
    on("dialog_ok", () => void this.okDialog());
    on("dialog_cancel", () => this.closeDialog());
    on("chip", ((id: string) => {
      this.chipState.set(id, !this.chipState.get(id));
      this.renderChips();
    }) as Cb);
    on("color", ((id: string) => {
      this.colorPick = id;
      this.renderColors();
    }) as Cb);
    on("add_person", () => this.personDialog(null));
    on("prev", () => this.step(-1));
    on("next", () => this.step(1));
    on("settle", ((sec: string) => void this.settle(sec)) as Cb);
    on("toast_act", () => {
      const f = this.toastAction;
      this.setToast("");
      f?.();
    });
    ctx.onChanged(() => void this.refresh());
  }

  // ---------- data ----------

  async start(): Promise<void> {
    await this.refresh();
    void this.loop();
  }

  /** Long-poll: the engine answers when its rev moves (or after 25 s). */
  private async loop(): Promise<void> {
    while (this.alive) {
      try {
        const rev = this.state?.rev ?? 0;
        const r = await this.ctx.call("GET", "v1/persons/state", { rev: String(rev) });
        if (r.status === 200) this.applyState(r.body as StateJson);
        else await new Promise((res) => setTimeout(res, 2000));
      } catch {
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  }

  private async refresh(): Promise<void> {
    try {
      const r = await this.ctx.call("GET", "v1/persons/state");
      if (r.status === 200) this.applyState(r.body as StateJson);
      else this.bus.note = String((r.body as { error?: string } | null)?.error ?? `Persons answered ${r.status}`);
    } catch (e) {
      this.bus.note = e instanceof Error ? e.message : String(e);
    }
  }

  private applyState(s: StateJson): void {
    if (s.loading) return;
    const before = this.state;
    this.state = s;
    if (this.ui.open && !s.people.some((p) => p.id === this.ui.open?.id)) {
      this.ui.open = null;
      this.chat = null;
    }
    const linking = s.connections.find((c) => c.kind === "whatsapp" && c.status === "signing-in");
    if (linking && (this.bus.dialog === "" || this.bus.dialog === "qr")) void this.showQr(linking.qr);
    else if (!linking && this.bus.dialog === "qr") this.closeDialog();
    this.render();
    // the open chat follows its person's row (a message, typing, presence)
    const open = this.ui.open;
    if (open) {
      const was = before?.people.find((p) => p.id === open.id);
      const now = s.people.find((p) => p.id === open.id);
      if (JSON.stringify(was?.rows) !== JSON.stringify(now?.rows) || before?.rev !== s.rev) void this.loadChat(false);
    }
  }

  private person(id: string): PersonJson | undefined {
    return this.state?.people.find((p) => p.id === id);
  }

  private async api(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await this.ctx.call(method, `v1/persons/${path}`, query, body);
    return { status: r.status, body: (r.body ?? {}) as Record<string, unknown> };
  }

  // ---------- rendering ----------

  private render(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.draw();
    });
  }

  private rowJs(r: Row): Record<string, unknown> {
    const px = r.avatarPath ? this.pics.get(r.avatarPath, r.kind === "store" ? 48 : 96) : null;
    return {
      kind: r.kind,
      id: r.id,
      section: r.section,
      store: r.store,
      name: r.name,
      initials: r.initials,
      color: r.color,
      avatar: px ?? NO_PX,
      has_avatar: !!px,
      presence: r.presence,
      status: r.status,
      tone: r.tone,
      channel: r.channel,
      time: r.time,
      unread: r.unread,
      typing: r.typing,
      owner: r.owner,
      active: r.active,
      expanded: r.expanded,
      count: r.count,
      depth: r.depth,
      dim: r.dim,
    };
  }

  private draw(): void {
    const b = this.bus;
    const s = this.state;
    if (!s) {
      b.view = "loading";
      return;
    }
    const same = (x: Record<string, unknown>, y: Record<string, unknown>): boolean => x.avatar === y.avatar && JSON.stringify({ ...x, avatar: 0 }) === JSON.stringify({ ...y, avatar: 0 });
    syncRows(this.sideModel, sideRows(s, this.ui).map((r) => this.rowJs(r)), same);
    b.unread_total = s.unread;
    const off = s.connections.filter((c) => c.status === "signed-out");
    b.note = off.length ? `${off.map((c) => `${SECTION_LABEL[c.section]} ${KIND_LABEL[c.kind]}`).join(", ")} signed out` : "";
    if (!this.ui.open || !this.chat) {
      b.view = this.ui.open ? "chat" : "list";
      const rows = listRows(s, this.query, this.ui.open);
      syncRows(this.listModel, rows.map((r) => this.rowJs(r)), same);
      b.list_title = "All people";
      b.list_sub = this.query ? `${rows.length} of ${s.people.length} match “${this.query}”` : `${s.people.length} ${s.people.length === 1 ? "person" : "people"}`;
      if (!this.ui.open) return;
    }
    b.view = "chat";
    this.drawChat();
    this.drawPanel();
  }

  private drawChat(): void {
    const b = this.bus;
    const c = this.chat;
    if (!c) {
      b.c_loading = true;
      syncRows(this.msgModel, []);
      return;
    }
    const pp = c.person;
    const px = this.pics.get(pp.avatarPath, 96);
    b.c_name = pp.name;
    b.c_initials = pp.initials;
    b.c_color = pp.color;
    b.c_avatar = px ?? NO_PX;
    b.c_has_avatar = !!px;
    b.c_presence = pp.presence ?? "";
    b.c_status = c.typing ? (c.typing === "recording" ? "recording audio…" : "typing…") : pp.status?.text ?? "";
    b.c_tone = c.typing ? "green" : pp.status?.tone ?? "";
    b.c_channel = c.account?.kind ?? "";
    b.c_account = c.account ? c.account.label : "No channel";
    b.c_accounts = c.accounts.length > 1;
    b.c_gmail = c.account?.kind === "gmail";
    b.c_connected = !!c.account?.connected;
    b.c_more = c.more;
    b.c_loading = false;
    b.c_empty = c.account ? "No messages yet." : "No channel to talk to them here: connect Discord, Gmail or WhatsApp in the section's +, and give them that identifier (Edit).";
    b.reply_text = this.replyTo?.text ?? "";
    b.ai_mode = this.aiMode;
    b.panel = this.panelOpen;
    const rows = chatRows(c).slice(-400);
    const js = rows.map((r) => this.msgJs(r));
    syncRows(this.msgModel, js, (x, y) => x.image === y.image && JSON.stringify({ ...x, image: 0 }) === JSON.stringify({ ...y, image: 0 }));
  }

  private attachPaths = new Map<string, string | null>();

  private msgJs(r: MsgRow): Record<string, unknown> {
    let px: Pixels | null = null;
    if (r.imageUrl) {
      const known = this.attachPaths.get(r.imageUrl);
      if (known === undefined) {
        this.attachPaths.set(r.imageUrl, null);
        void this.fetchPath(r.imageUrl).then((p) => {
          this.attachPaths.set(r.imageUrl, p);
          if (p) this.render();
        });
      } else if (known) px = this.pics.get(known, 640);
    }
    return {
      kind: r.kind,
      id: r.id,
      mine: r.mine,
      text: r.text,
      time: r.time,
      meta: r.meta,
      reply: r.reply,
      has_reply: r.reply !== "",
      image: px ?? NO_PX,
      has_image: !!r.imageUrl,
      img_w: r.imgW,
      img_h: r.imgH,
      files: r.files,
      first: r.first,
      failed: r.failed,
      sending: r.sending,
      streaming: r.streaming,
    };
  }

  /** A file route's local path (the engine downloads it once). */
  private async fetchPath(url: string): Promise<string | null> {
    const u = new URL(url, "http://hub");
    const q: Record<string, string> = {};
    for (const [k, v] of u.searchParams) q[k] = v;
    q.path = "1";
    const r = await this.ctx.call("GET", u.pathname.replace(/^\//, ""), q).catch(() => null);
    const p = r && r.status === 200 ? (r.body as { path?: string }).path : undefined;
    return p ?? null;
  }

  private drawPanel(): void {
    const b = this.bus;
    const d = this.panelData;
    if (!d || !this.panelOpen) return;
    const px = this.pics.get(d.avatarPath, 256);
    b.p_name = d.name;
    b.p_initials = d.initials;
    b.p_color = d.color;
    b.p_avatar = px ?? NO_PX;
    b.p_has_avatar = !!px;
    const p = d.person;
    b.p_sub = [p.discordUsername ? `@${p.discordUsername}` : "", p.email ?? ""].filter(Boolean).join(" · ");
    b.p_details = d.identities.map((i) => ({ label: i.section ? SECTION_LABEL[i.section] ?? "" : "", value: i.label, icon: i.kind, link: "" }));
    b.p_groups = [...d.stores.map((s) => ({ id: `s:${s.id}`, label: s.name, on: s.owner, color: s.color })), ...d.lists.map((l) => ({ id: `l:${l.id}`, label: l.name, on: false, color: "#64748b" }))];
    const secs = [...(d.stores.length ? ["stores"] : []), ...d.lists.map((l) => l.id).filter((x) => x in SECTION_LABEL)];
    b.p_settle = secs.map((sec) => ({ id: sec, label: SECTION_LABEL[sec] ?? sec, on: !!this.person(p.id)?.settled[sec], color: "#64748b" }));
    b.p_socials = d.socials.map((s) => ({
      platform: s.platform ? s.platform[0]!.toUpperCase() + s.platform.slice(1) : "Link",
      handle: s.handle ?? s.url,
      url: s.url,
      note: s.note ?? "",
      uploads: s.uploads.slice(0, 3).map((u) => {
        const f = u.thumb ? this.attachPaths.get(u.thumb) : null;
        if (u.thumb && f === undefined) {
          this.attachPaths.set(u.thumb, null);
          void this.ctx.call("GET", "v1/persons/img/url", { u: u.thumb, path: "1" }).then((r) => {
            const path = r.status === 200 ? (r.body as { path?: string }).path ?? null : null;
            this.attachPaths.set(u.thumb!, path);
            if (path) this.render();
          }, () => {});
        }
        const tpx = f ? this.pics.get(f, 320) : null;
        return { title: u.title, meta: u.meta ?? "", url: u.url, thumb: tpx ?? NO_PX, has_thumb: !!tpx };
      }),
    }));
    const order = this.order();
    const i = order.indexOf(p.id);
    b.p_pos = i >= 0 ? `${i + 1} of ${order.length}` : "";
  }

  // ---------- opening a person ----------

  private order(): string[] {
    const s = this.state;
    if (!s) return [];
    const open = this.ui.open;
    if (open && open.section) return sideRows(s, this.ui).filter((r) => r.kind === "person" && r.section === open.section && !r.dim).map((r) => r.id);
    return listRows(s, this.query, null).map((r) => r.id);
  }

  private step(d: number): void {
    const order = this.order();
    const cur = this.ui.open;
    if (!cur) return;
    const i = order.indexOf(cur.id);
    const next = order[i + d];
    if (next) void this.openPerson(next, cur.section, "");
  }

  private async openPerson(id: string, section: string, store: string): Promise<void> {
    if (this.ui.open?.id === id && this.ui.open.section === section && this.ui.open.store === store) return;
    this.ui.open = { id, section, store };
    this.ui.allActive = false;
    this.chat = null;
    this.panelData = null;
    this.replyTo = null;
    this.aiMode = false;
    this.bus.draft = "";
    this.bus.subject = "";
    this.render();
    await Promise.all([this.loadChat(true), this.panelOpen ? this.loadPanel() : Promise.resolve()]);
  }

  private account: string | null = null;

  private async loadChat(first: boolean): Promise<void> {
    const open = this.ui.open;
    if (!open) return;
    const seq = ++this.chatSeq;
    if (first) this.account = null;
    const q: Record<string, string> = { section: open.section };
    if (this.account) q.account = this.account;
    const r = await this.ctx.call("GET", `v1/persons/chat/${encodeURIComponent(open.id)}`, q).catch(() => null);
    if (seq !== this.chatSeq || this.ui.open !== open || !r || r.status !== 200) return;
    const c = r.body as ChatJson;
    this.chat = c;
    this.render();
    // seen: the newest message (as opening it in the official client does)
    const unread = this.person(open.id)?.rows[open.section]?.unread ?? 0;
    if (unread > 0 && this.ctx.shown()) void this.api("POST", `chat/${encodeURIComponent(open.id)}/read`, { section: open.section, account: c.account?.id });
  }

  private async loadPanel(): Promise<void> {
    const open = this.ui.open;
    if (!open) return;
    const r = await this.api("GET", `person/${encodeURIComponent(open.id)}`).catch(() => null);
    if (!r || r.status !== 200 || this.ui.open?.id !== open.id) return;
    this.panelData = r.body as unknown as PanelJson;
    this.bus.p_notes = this.panelData.person.notes ?? "";
    this.render();
  }

  private async older(): Promise<void> {
    const open = this.ui.open;
    const c = this.chat;
    const first = c?.messages[0];
    if (!open || !c || !first || !c.more) return;
    this.bus.c_loading = true;
    const r = await this.ctx.call("GET", `v1/persons/chat/${encodeURIComponent(open.id)}`, { section: open.section, before: first.id, ...(c.account ? { account: c.account.id } : {}) }).catch(() => null);
    this.bus.c_loading = false;
    if (!r || r.status !== 200 || this.chat !== c) return;
    const page = r.body as { messages: ChatJson["messages"]; more: boolean };
    c.messages = [...page.messages, ...c.messages.filter((m) => !page.messages.some((x) => x.id === m.id))];
    c.more = page.more && page.messages.length > 0;
    this.render();
  }

  // ---------- sending ----------

  private async send(): Promise<void> {
    const open = this.ui.open;
    const text = String(this.bus.draft ?? "").replace(/\s+$/, "");
    if (!open || !text.trim()) return;
    this.bus.draft = "";
    if (this.aiMode) {
      const r = await this.api("POST", `chat/${encodeURIComponent(open.id)}/ai`, { section: open.section || this.chat?.account?.section || "stores", text, account: this.chat?.account?.id });
      if (r.status !== 200) {
        this.bus.draft = text;
        this.setToast(String(r.body.error ?? "The Person AI didn't answer"));
      }
      void this.loadChat(false);
      return;
    }
    const body: Record<string, unknown> = { section: open.section, account: this.chat?.account?.id, text };
    if (this.replyTo) body.replyTo = this.replyTo.id;
    const subject = String(this.bus.subject ?? "").trim();
    if (subject) body.subject = subject;
    this.replyTo = null;
    this.bus.subject = "";
    this.render();
    const r = await this.api("POST", `chat/${encodeURIComponent(open.id)}/send`, body);
    if (r.status !== 200 || r.body.ok === false) this.setToast(String(r.body.error ?? "Not sent"));
    void this.loadChat(false);
  }

  private typing(): void {
    const open = this.ui.open;
    if (!open || this.aiMode || Date.now() - this.typingAt < 8000) return;
    this.typingAt = Date.now();
    void this.api("POST", `chat/${encodeURIComponent(open.id)}/typing`, { section: open.section, account: this.chat?.account?.id, on: true });
  }

  private async openFile(id: string): Promise<void> {
    const m = this.chat?.messages.find((x) => x.id === id);
    const f = m?.files[0];
    if (!f) return;
    const path = await this.fetchPath(f.url);
    if (path) this.ctx.openExternal(path);
    else this.setToast("Couldn't download that file");
  }

  // ---------- menus ----------

  private showMenu(x: number, y: number, items: { id?: string; label: string; icon?: string; sub?: string; danger?: boolean; sep?: boolean; header?: boolean; disabled?: boolean; run?: () => void }[]): void {
    this.menuActions.clear();
    let n = 0;
    this.bus.menu = items.map((it) => {
      const id = it.id ?? `m${n++}`;
      if (it.run) this.menuActions.set(id, it.run);
      return { id, label: it.label, icon: it.icon ?? "", sub: it.sub ?? "", danger: !!it.danger, sep: !!it.sep, header: !!it.header, disabled: !!it.disabled };
    });
    this.bus.menu_x = x;
    this.bus.menu_y = y;
    this.bus.menu_open = true;
  }

  private pick(id: string): void {
    this.bus.menu_open = false;
    if (id === "panel:edit" && this.ui.open) return this.personDialog(this.ui.open.id);
    if (id === "panel:rename" && this.ui.open) return this.renameDialog(this.ui.open.id);
    if (id === "panel:delete" && this.ui.open) return void this.deletePerson(this.ui.open.id);
    this.menuActions.get(id)?.();
  }

  private sectionMenu(sec: string, x: number, y: number): void {
    const s = this.state;
    if (!s) return;
    const mine = s.connections.filter((c) => c.section === sec);
    const status = (c: (typeof mine)[number]): string => (c.status === "connected" ? (c.gateway === "up" || c.kind !== "discord" ? "Connected" : "Reconnecting…") : c.status === "connecting" || c.status === "starting" ? "Connecting…" : c.status === "signing-in" ? "Signing in…" : "Signed out");
    this.showMenu(x, y, [
      sec === "stores" ? { label: "New store", icon: "", run: () => this.storeDialog(null) } : { label: `Add to ${SECTION_LABEL[sec]}`, run: () => this.personDialog(null, sec) },
      ...(sec === "stores" ? [{ label: "Add person", run: () => this.personDialog(null, sec) }] : []),
      { sep: true, label: "" },
      { header: true, label: "CONNECTIONS" },
      ...(mine.length ? [] : [{ label: "None yet.", disabled: true }]),
      ...mine.map((c) => ({
        label: c.who || KIND_LABEL[c.kind] || c.kind,
        icon: c.kind,
        sub: `${KIND_LABEL[c.kind]} · ${status(c)}${c.error ? ` · ${c.error}` : ""}`,
        run: () => (c.status === "connected" ? this.confirm(`Disconnect ${KIND_LABEL[c.kind]}${c.who ? ` (${c.who})` : ""}?`, "It leaves this section and signs out. Connect it again to use it.", "Disconnect", async () => void (await this.api("DELETE", `connections/${encodeURIComponent(c.id)}`))) : void this.api("POST", `connections/${encodeURIComponent(c.id)}/connect`)),
      })),
      { sep: true, label: "" },
      ...["discord", "gmail", "whatsapp"].map((k) => ({ label: `Connect ${KIND_LABEL[k]}`, icon: k, run: () => void this.api("POST", "connections", { section: sec, kind: k }) })),
    ]);
  }

  private rowMenu(id: string, sec: string, store: string, x: number, y: number): void {
    const p = this.person(id);
    if (!p) return;
    const settled = !!(sec && p.settled[sec]);
    this.showMenu(x, y, [
      { label: "Open", run: () => void this.openPerson(id, sec, store) },
      { label: "Rename", icon: "", run: () => this.renameDialog(id) },
      { label: "Edit…", run: () => this.personDialog(id) },
      ...(sec ? [{ label: settled ? "Unsettle" : "Settle", run: () => void this.api("PATCH", `person/${encodeURIComponent(id)}`, { settle: { section: sec, on: !settled } }) }] : []),
      ...(store ? [{ label: `Remove from ${this.state?.stores.find((s) => s.id === store)?.name ?? "the store"}`, run: () => void this.removeFromStore(id, store) }] : []),
      ...(store ? [{ label: "Make store owner", run: () => void this.api("PATCH", `stores/${encodeURIComponent(store)}`, { ownerId: id }) }] : []),
      { sep: true, label: "" },
      { label: "Delete", danger: true, run: () => void this.deletePerson(id) },
    ]);
  }

  private storeMenu(id: string, x: number, y: number): void {
    const st = this.state?.stores.find((s) => s.id === id);
    if (!st) return;
    this.showMenu(x, y, [
      { label: `Add to ${st.name}`, run: () => this.personDialog(null, "stores", id) },
      { label: "Edit store…", run: () => this.storeDialog(id) },
      { sep: true, label: "" },
      { label: "Delete store", danger: true, run: () => this.confirm(`Delete ${st.name}?`, "Its people stay (they just leave the store).", "Delete", async () => void (await this.api("DELETE", `stores/${encodeURIComponent(id)}`))) },
    ]);
  }

  private accountMenu(x: number, y: number): void {
    const c = this.chat;
    if (!c) return;
    this.showMenu(x, y, c.accounts.map((a) => ({ label: a.label, icon: a.kind, sub: a.id === c.account?.id ? "In use" : "", run: () => {
      this.account = a.id;
      void this.loadChat(false);
    } })));
  }

  private msgMenu(id: string, x: number, y: number): void {
    const open = this.ui.open;
    const c = this.chat;
    if (!open || !c) return;
    if (id.startsWith("oo")) {
      const key = id.slice(1);
      this.showMenu(x, y, [
        { label: "Retry", run: () => void this.api("POST", `chat/${encodeURIComponent(open.id)}/retry`, { section: open.section, account: c.account?.id, key }) },
        { label: "Dismiss", danger: true, run: () => void this.api("POST", `chat/${encodeURIComponent(open.id)}/retry`, { section: open.section, account: c.account?.id, key, dismiss: true }) },
      ]);
      return;
    }
    const m = c.messages.find((x) => x.id === id);
    if (!m) return;
    this.showMenu(x, y, [
      { label: "Reply", run: () => {
        this.replyTo = { id: m.id, text: `${m.fromMe ? "you" : c.person.name}: ${m.text.slice(0, 80) || "attachment"}` };
        this.aiMode = false;
        this.render();
      } },
      { label: "Ask the AI about this", icon: "", run: () => {
        this.aiMode = true;
        this.bus.draft = `About their message “${m.text.slice(0, 200)}”: `;
        this.render();
      } },
      ...(!m.fromMe ? [{ label: "Mark as unread", run: () => void this.api("POST", `chat/${encodeURIComponent(open.id)}/unread`, { section: open.section, account: c.account?.id, messageId: m.id }) }] : []),
      ...(m.files.length ? [{ label: "Open attachment", run: () => void this.openFile(m.id) }] : []),
    ]);
  }

  // ---------- people ----------

  private async removeFromStore(id: string, store: string): Promise<void> {
    const p = this.person(id);
    if (!p) return;
    await this.api("PATCH", `person/${encodeURIComponent(id)}`, { storeIds: p.storeIds.filter((s) => s !== store) });
    this.setToast(`Removed ${p.name} from ${this.state?.stores.find((s) => s.id === store)?.name ?? "the store"}`, "Undo", () => void this.api("PATCH", `person/${encodeURIComponent(id)}`, { storeIds: p.storeIds }));
  }

  private async deletePerson(id: string): Promise<void> {
    const r = await this.api("DELETE", `person/${encodeURIComponent(id)}`);
    const p = r.body.person as Record<string, unknown> | undefined;
    if (this.ui.open?.id === id) {
      this.ui.open = null;
      this.chat = null;
    }
    this.render();
    if (p) this.setToast(`Deleted ${String(p.name || "them")}`, "Undo", () => void this.api("POST", "people", { ...p, restore: true }));
  }

  private async saveNotes(text: string): Promise<void> {
    const open = this.ui.open;
    if (!open || !this.panelData || (this.panelData.person.notes ?? "") === text) return;
    this.panelData.person.notes = text;
    await this.api("PATCH", `person/${encodeURIComponent(open.id)}`, { notes: text });
  }

  private async settle(sec: string): Promise<void> {
    const open = this.ui.open;
    if (!open) return;
    const on = !this.person(open.id)?.settled[sec];
    await this.api("PATCH", `person/${encodeURIComponent(open.id)}`, { settle: { section: sec, on } });
    await this.refresh();
    this.render();
  }

  // ---------- dialogs ----------

  private openDialog(kind: string, title: string, text: string, ok: string, run: () => Promise<void> | void, danger = false): void {
    const b = this.bus;
    b.d_title = title;
    b.d_text = text;
    b.d_ok = ok;
    b.d_danger = danger;
    b.d_error = "";
    b.d_busy = false;
    this.dialogOk = run;
    b.dialog = kind;
  }

  private closeDialog(): void {
    this.bus.dialog = "";
    this.dialogOk = null;
  }

  private async okDialog(): Promise<void> {
    const f = this.dialogOk;
    if (!f) return this.closeDialog();
    this.bus.d_busy = true;
    try {
      await f();
      this.closeDialog();
    } catch (e) {
      this.bus.d_error = e instanceof Error ? e.message : String(e);
    } finally {
      this.bus.d_busy = false;
    }
  }

  private confirm(title: string, text: string, ok: string, run: () => Promise<void>): void {
    this.openDialog("confirm", title, text, ok, run, true);
  }

  private renameDialog(id: string): void {
    const p = this.person(id);
    if (!p) return;
    this.bus.f_name = p.name;
    this.openDialog("rename", `Rename ${p.name}`, "Your own name for them: shown everywhere, never overwritten by Discord, Gmail or WhatsApp.", "Rename", async () => {
      const name = String(this.bus.f_name ?? "").trim();
      if (name) await this.api("PATCH", `person/${encodeURIComponent(id)}`, { name });
    });
  }

  private renderChips(): void {
    const s = this.state;
    if (!s) return;
    this.bus.f_chips = [...s.stores.map((st) => ({ id: `s:${st.id}`, label: st.name, on: !!this.chipState.get(`s:${st.id}`), color: st.color })), ...s.lists.map((l) => ({ id: `l:${l.id}`, label: l.name, on: !!this.chipState.get(`l:${l.id}`), color: "#64748b" }))];
  }

  private renderColors(): void {
    this.bus.f_colors = COLORS.map((c) => ({ id: c, label: c, on: c === this.colorPick, color: c }));
  }

  private personDialog(id: string | null, section?: string, store?: string): void {
    const b = this.bus;
    const s = this.state;
    if (!s) return;
    this.chipState.clear();
    void (async () => {
      let p: PanelJson["person"] | null = null;
      if (id) {
        const r = await this.api("GET", `person/${encodeURIComponent(id)}`);
        if (r.status !== 200) return;
        p = (r.body as unknown as PanelJson).person;
      }
      b.f_name = p?.name ?? "";
      b.f_discord = p ? p.discordId || (p.discordUsername ? `@${p.discordUsername}` : "") : "";
      b.f_email = p?.email ?? "";
      b.f_whatsapp = p?.whatsapp ? `+${p.whatsapp}` : "";
      b.f_socials = (p?.socials ?? []).join(" ");
      for (const sid of p?.storeIds ?? (store ? [store] : [])) this.chipState.set(`s:${sid}`, true);
      for (const lid of p?.listIds ?? (section && section !== "stores" ? [section] : [])) this.chipState.set(`l:${lid}`, true);
      this.renderChips();
      this.openDialog("person", p ? `Edit ${p.name || "person"}` : "Add person", "", p ? "Save" : "Add", async () => {
        const discord = String(b.f_discord ?? "").trim().replace(/^@/, "");
        const fields: Record<string, unknown> = {
          name: String(b.f_name ?? "").trim(),
          email: String(b.f_email ?? "").trim(),
          whatsapp: String(b.f_whatsapp ?? "").trim(),
          storeIds: [...this.chipState].filter(([k, v]) => v && k.startsWith("s:")).map(([k]) => k.slice(2)),
          listIds: [...this.chipState].filter(([k, v]) => v && k.startsWith("l:")).map(([k]) => k.slice(2)),
          socials: String(b.f_socials ?? "").split(/\s+/).filter((u) => /^https:\/\//.test(u)),
        };
        if (/^\d{15,21}$/.test(discord)) fields.discordId = discord;
        else if (discord) fields.discordUsername = discord;
        else if (p) fields.discordId = "";
        if (p) {
          const r = await this.api("PATCH", `person/${encodeURIComponent(p.id)}`, fields);
          if (r.status !== 200) throw new Error(String(r.body.error ?? "Not saved"));
          if (this.ui.open?.id === p.id) void this.loadPanel();
        } else {
          const r = await this.api("POST", "people", fields);
          if (r.status !== 200 || r.body.ok === false) throw new Error(String(r.body.error ?? "Not added"));
          const np = r.body.person as { id?: string } | undefined;
          await this.refresh();
          if (np?.id) void this.openPerson(np.id, section ?? "", store ?? "");
        }
      });
    })();
  }

  private storeDialog(id: string | null): void {
    const st = id ? this.state?.stores.find((s) => s.id === id) : undefined;
    this.bus.f_name = st?.name ?? "";
    this.colorPick = st?.color ?? COLORS[(this.state?.stores.length ?? 0) % COLORS.length]!;
    this.renderColors();
    this.bus.f_chips = [];
    this.openDialog("store", st ? `Edit ${st.name}` : "New store", "", st ? "Save" : "Create", async () => {
      const name = String(this.bus.f_name ?? "").trim();
      if (!name) throw new Error("A store needs a name");
      const r = st ? await this.api("PATCH", `stores/${encodeURIComponent(st.id)}`, { name, color: this.colorPick }) : await this.api("POST", "stores", { name, color: this.colorPick });
      if (r.status !== 200) throw new Error(String(r.body.error ?? "Not saved"));
    });
  }

  private async showQr(text: string | null): Promise<void> {
    if (this.bus.dialog !== "qr") this.openDialog("qr", "Link WhatsApp", "On your phone: WhatsApp › Settings › Linked devices › Link a device, then scan this code.", "", () => {});
    if (!text) {
      this.bus.has_qr = false;
      return;
    }
    this.qr ??= (await loadQr()) as (t: string) => Pixels;
    this.bus.qr = this.qr(text);
    this.bus.has_qr = true;
  }

  private toggle(set: Set<string>, id: string): void {
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.render();
  }

  private setToast(text: string, action = "", run?: () => void): void {
    this.bus.toast = text;
    this.bus.toast_action = action;
    this.toastAction = run ?? null;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (text) this.toastTimer = setTimeout(() => this.setToast(""), action ? 8000 : 4000);
  }

  stop(): void {
    this.alive = false;
  }
}

let tab: PersonsTab | null = null;

export const personsUi: TabUi = {
  id: "persons",
  mount: async (ctx) => {
    tab = new PersonsTab(ctx);
    Reflect.set(Reflect.get(ctx.win, "PersonsBus") as object, "ready", true);
    await tab.start();
  },
  shown: (on) => {
    if (on) void tab?.["refresh"]();
  },
};
