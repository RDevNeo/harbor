import type { Account, agent, Engine } from "./packages/agents/src/index.ts";
import {
  AUTO_DEVICE,
  type AutoCandidate,
  autoKey,
  configLines,
  glyph,
  hostLabel,
  loadRemote,
  newHost,
  type MovePc,
  type Peer,
  pickAuto,
  placeName,
  placeOf,
  ramText,
  relocateBlocker,
  relocateCheck,
  relocatedText,
  relocateFailedText,
  type RelocateDev,
  type RelocatePlace,
  relocateRun,
  relocateSessions,
  relocateWhy,
  type RemoteHost,
  type Remotes,

} from "./packages/net/src/index.ts";
import type { Chat, Store } from "./packages/store/src/index.ts";

/** One row of the composer's "Runs on" menu (remoteui.rs `device_menu`). */
export interface RunOnRow {
  id: string;
  name: string;
  /** The row's glyph; "" for this PC. */
  glyph: string;
  desc: string;
  online: boolean | null;
  current: boolean;
  enabled: boolean;
}

export interface RunOnDeps {
  store: Store;
  engine: Engine;
  mover: MovePc;
  remotes: Remotes;
  meshOn: () => boolean;
  /** The PCs running Harbor with chats shared (mesh.rs `mesh_hosts`). */
  hosts: () => Peer[];
  me: () => { name: string; hostname: string };
  accounts: () => readonly Account[];
  remoteSpec: (chat: Chat, account: Account) => agent.RemoteSpec | null;
  dataDir: string;
  home: string;
  /** The profiles of chats commanded from other PCs, where a session may have been written. */
  overlays: () => string[];
  /** This PC's free memory in MB (ram.ts RamMeter); null: not known. */
  ram?: () => number | null;
}

/** Sparkles: the Auto row's glyph. */
const AUTO_GLYPH = "\u{e412}";

/** "Runs on": the composer's device menu and relocate.rs's move of a started chat between this PC, its devices and other PCs. */
export class RunOn {
  onToast: (text: string) => void = () => {};

  constructor(private readonly d: RunOnDeps) {}

  private devices(): [RemoteHost, boolean | null][] {
    return this.d.remotes.devices(loadRemote(this.d.store), this.d.remotes.tailnetCached());
  }

  private subsOf(id: number): Chat[] {
    return this.d.engine.allSubsOf(id);
  }

  private claude(c: Chat): boolean {
    return this.d.accounts().find((a) => a.id === c.account)?.kind === "Claude";
  }

  /** relocate.rs `relocate_blocker`. */
  blocker(chatId: number): string | null {
    const c = this.d.engine.chat(chatId);
    if (!c) return "no such chat";
    const lead = c.device === "" ? null : this.devices().find(([h]) => h.id === c.device);
    return relocateBlocker({
      foreignHome: c.home !== "" ? (this.d.hosts().find((p) => p.id === c.home)?.name ?? c.home) : null,
      isSub: c.role === "sub",
      movingTo: this.d.mover.movingTo(chatId),
      chats: [c, ...this.subsOf(chatId)].map((x) => ({ id: x.id, name: x.name, device: x.device, claude: this.claude(x), running: this.d.engine.running(x.id) })),
      leadDevice: lead ? { os: lead[0].os } : null,
    });
  }

  why(chatId: number, to: string): string | null {
    const c = this.d.engine.chat(chatId);
    if (!c) return "no such chat";
    return relocateWhy({ started: c.started, device: c.device, to, blocker: () => this.blocker(chatId), place: placeOf(to, this.d.hosts(), this.devices()), meshOn: this.d.meshOn() });
  }

  /** The menu's rows: this PC, the devices (hidden ones only while picked), then PCs running Harbor that aren't devices.
   * A row is its icon and name; only Auto's says more (where it would go), and a row that can't be picked says why. */
  rows(chatId: number | null, current: string, kind: string): RunOnRow[] {
    const c = chatId === null ? undefined : this.d.engine.chat(chatId);
    const started = c?.started === true;
    const locked = c?.home !== undefined && c.home !== "";
    const why = (id: string) => (started && chatId !== null && !locked ? this.why(chatId, id) : null);
    const claude = kind === "Claude";
    const devs = this.devices().filter(([h]) => !h.hidden || h.id === current);
    const hubs = this.d.hosts();
    const out: RunOnRow[] = [];
    const hereWhy = why("");
    out.push({ id: "", name: "This PC", glyph: "", desc: hereWhy ?? "", online: null, current: current === "", enabled: (!locked || current === "") && hereWhy === null });
    // Auto, second (a pick that's gone falls back to the first, this PC), only for a chat not made yet (the draft):
    // it's decided at its first message.
    if (chatId === null) {
      const best = this.autoPick(kind);
      const desc = best === null ? "No PC can take it now" : `Most free memory now: ${best.id === "" ? "This PC" : best.name}${best.ram === null ? "" : ` · ${ramText(best.ram)}`}`;
      out.push({ id: AUTO_DEVICE, name: "Auto", glyph: AUTO_GLYPH, desc, online: null, current: current === AUTO_DEVICE, enabled: best !== null });
    }
    for (const [h, online] of devs) {
      const no = why(h.id);
      const hub = hubs.find((p) => p.id === h.id);
      const desc = !claude ? "Claude Code only" : no !== null ? no : hub !== undefined && !hub.online ? "Harbor · off" : "";
      out.push({ id: h.id, name: hostLabel(h), glyph: glyph(h), desc, online, current: h.id === current, enabled: claude && (!locked || h.id === current) && no === null && (hub === undefined || hub.online) });
    }
    for (const p of hubs.filter((x) => !devs.some(([h]) => h.id === x.id))) {
      const no = why(p.id);
      const desc = no !== null ? no : !p.online ? "Harbor · off" : "";
      out.push({ id: p.id, name: p.name, glyph: glyph(newHost({ os: "linux" })), desc, online: p.online, current: p.id === current, enabled: claude && !locked && p.online && no === null });
    }
    return out;
  }

  /** The PCs Auto picks among: this PC and the other PCs running Harbor that can take a new chat now (on, sharing, with a Claude account).
   * SSH devices aren't: there's no free-memory figure for them. Only Claude chats go to other PCs. */
  autoCandidates(kind: string): AutoCandidate[] {
    const me = this.d.me();
    const out: AutoCandidate[] = [{ id: "", name: me.name === "" ? me.hostname : me.name, ram: this.d.ram?.() ?? null }];
    if (kind !== "Claude" || !this.d.meshOn()) return out;
    for (const p of this.d.hosts()) {
      if (!p.online || !p.accounts.some((a) => a[2] === "claude")) continue;
      out.push({ id: p.id, name: p.name === "" ? p.id : p.name, ram: p.ram });
    }
    return out;
  }

  /** Where Auto puts a new chat now: the PC with the most free memory (ram.ts `pickAuto`). */
  autoPick(kind: string): AutoCandidate | null {
    return pickAuto(this.autoCandidates(kind));
  }

  /** A device field as the chat gets it: "auto" becomes the PC picked now ("" when none can be: this PC). */
  resolve(device: string, kind: string): { device: string; auto: boolean } {
    if (device !== AUTO_DEVICE) return { device, auto: false };
    return { device: this.autoPick(kind)?.id ?? "", auto: true };
  }

  /** Remembers that Auto put the chat `gid` on `place` ("" this PC, else a PC's id). */
  markAuto(gid: string, place: string): void {
    if (gid !== "") this.d.store.set(autoKey(gid), place);
  }

  /** "Auto → <PC>" for a chat Auto placed, while it's still there; null otherwise (`here`: this PC's own name for itself). */
  autoLabel(c: Chat, here = "This PC"): string | null {
    const placed = c.gid === "" ? null : this.d.store.get(autoKey(c.gid));
    if (placed === null || placed === undefined) return null;
    const at = c.home !== "" ? c.home : c.device;
    if (placed !== at) return null;
    if (at === "") return `Auto \u{2192} ${here}`;
    const p = this.d.hosts().find((x) => x.id === at);
    return `Auto \u{2192} ${p?.name || at}`;
  }

  private devOf(chat: Chat, h: RemoteHost): RelocateDev {
    const account = this.d.accounts().find((a) => a.id === chat.account);
    if (!account) throw new Error("the chat's account is gone");
    const spec = this.d.remoteSpec({ ...chat, device: h.id }, account);
    if (spec === null) throw new Error("no device");
    return { name: hostLabel(h), ssh: spec.ssh, host: spec.host, dir: spec.dir, config: configLines(spec.setup) };
  }

  /** relocate.rs `relocate`: the chat's sessions go to `to` ("" this PC, a device, a mesh PC), then it runs there. Resolves with the place's name once started; the outcome is a notice in the chat. */
  async relocate(chatId: number, to: string): Promise<string> {
    const w = this.why(chatId, to);
    if (w !== null) throw new Error(w);
    const lead = this.d.engine.chat(chatId);
    if (!lead) throw new Error("no such chat");
    if (to === lead.device) return "";
    const hosts = this.d.hosts();
    const devs = this.devices();
    const target = placeOf(to, hosts, devs)?.place;
    if (!target) throw new Error("no such device");
    const source = placeOf(lead.device, hosts, devs)?.place;
    if (!source) throw new Error("its device isn't in Settings › Devices anymore");
    const from = source.kind === "device" ? this.devOf(lead, source.host) : null;
    const toDev = target.kind === "device" ? this.devOf(lead, target.host) : null;
    const chats = [lead, ...this.subsOf(chatId)];
    const cwd = this.d.engine.chatCwd(lead);
    const sessions = relocateSessions(
      chats.map((c) => ({ name: c.name, started: c.started, session_id: c.sessionId, configDir: this.d.accounts().find((a) => a.id === c.account)?.configDir ?? null })),
      cwd,
    );
    const check = relocateCheck({ source, target, hasRepo: lead.repoId !== null, sourceDev: from, cwd });
    const me = this.d.me();
    const [srcName, dstName] = [placeName(source, me), placeName(target, me)];
    this.d.mover.local.relocating.set(chatId, dstName);
    this.d.engine.changed(chatId);
    const ids = chats.map((c) => c.id);
    void relocateRun({ from, to: toDev, sessions, check }, { home: this.d.home, dataDir: this.d.dataDir, overlays: this.d.overlays }).then(
      () => {
        this.d.mover.local.relocating.delete(chatId);
        void this.relocated(chatId, ids, to, target, srcName, dstName);
      },
      (e: unknown) => {
        this.d.mover.local.relocating.delete(chatId);
        const text = relocateFailedText(dstName, e instanceof Error ? e.message : String(e));
        this.d.engine.notice(chatId, "alert", text);
        this.onToast(text);
        this.d.mover.resume(chatId);
      },
    );
    return dstName;
  }

  private setDevices(ids: readonly number[], device: string): void {
    for (const id of ids) {
      const c = this.d.engine.chat(id);
      if (!c) continue;
      this.d.store.saveChat({ ...c, device });
      this.d.engine.host.forgetWorkspace?.(id);
      this.d.engine.changed(id);
    }
    this.d.engine.reload();
  }

  /** The sessions are where the next turn looks: the chat runs there from now on. */
  private async relocated(chatId: number, ids: readonly number[], to: string, target: RelocatePlace, from: string, name: string): Promise<void> {
    const old = this.d.engine.chat(chatId)?.device ?? "";
    this.setDevices(ids, target.kind === "hub" ? "" : to);
    if (target.kind === "hub") {
      try {
        await this.d.mover.movePc(chatId, target.peer.id);
      } catch (e) {
        this.setDevices(ids, old);
        const text = relocateFailedText(name, e instanceof Error ? e.message : String(e));
        this.d.engine.notice(chatId, "alert", text);
        this.onToast(text);
        this.d.mover.resume(chatId);
      }
      return;
    }
    const said = relocatedText(target, from, name);
    this.d.engine.notice(chatId, "monitor", said.notice, said.detail);
    this.onToast(said.toast);
    this.d.mover.resume(chatId);
  }
}

