import { agoShort, allowedKey, GITHUB_KEY, glyph, hostLabel, ICONS as DEVICE_ICONS, isFound, label as peerLabel, normalizeFp, OWNER_KEY, osLabel, peoplePcLine, SEND_KEY, short as keyShort, versionNewer } from "@harbor/net";
import type { Allowed, Kv, Me, NearbyPc, PairCode, Pc, Peer, RemoteConfig, RemoteHost, RemoteProbe, Seen } from "@harbor/net";
import { machines } from "@harbor/mcp";
import { ICONS } from "../icons.ts";
import { badge, btn, copy, field, form, list, row, rows, title, type Block, type BlockBadge, type BlockEdit, type BlockField, type BlockRow, type BlockTab } from "./settings-blocks.ts";
import { outsideBlocks, outsideEdited, outsidePressed, outsideToggled, type OutsideHost } from "./settings-outside.ts";

/** mesh.rs `CODE_TRIES`: wrong guesses a shown code survives. */
const CODE_TRIES = 5;
const UPDATING_SECS = 180;

/** A Harbor heard on this network that isn't paired (discover.rs `unpaired`). */
export interface LanPc {
  fp: string;
  name: string;
  addr: string;
  version: string;
}

/** Sharing chats between this user's PCs: what mesh_settings reads and does. */
export interface MeshHost {
  on(): boolean;
  setOn(on: boolean): void;
  me(): Me;
  myFp(): string;
  /** update.rs `version_label`: "0.108.0 (325cce6)". */
  versionLabel(): string;
  /** This build's own version, and the newest this PC has heard of. */
  ownVersion(): string;
  ownLatest(): string;
  peers(): Peer[];
  allowed(): Allowed[];
  seen(): ReadonlyMap<string, Seen>;
  lan(): LanPc[];
  /** Chats copied here from a peer. */
  chatsCopied(peerId: string): number;
  phonesOn(): boolean;
  setPhonesOn(on: boolean): void;
  port(): number;
  firewallBlocks(port: number): boolean;
  openFirewall(): void;
  /** This PC's addresses as "host:port", for the pairing code. */
  addrs(): string[];
  allow(key: string, name: string, allow: boolean): void;
  shareLevel(peerId: string): machines.Level;
  setShareLevel(peerId: string, l: machines.Level): void;
  updatePeers(ps: Peer[]): void;
  /** Turns "Automatically" on in those PCs' Updates settings. */
  autoUpdatePeers(ps: Peer[]): void;
  enablePhonesOn(p: Peer): void;
  copy(text: string): void;
}

/** Settings › Devices › Pair a PC. */
export interface PairHost {
  shown(): PairCode | null;
  /** Makes a code and shows it; an error text when it can't. */
  show(): string | null;
  cancel(): void;
  busy(): boolean;
  join(addr: string, code: string): void;
  /** How the last pairing went. */
  result(): { ok: boolean; text: string } | null;
}

/** People and memory (meshctx.rs `people_ui`). */
export interface PeopleHost {
  /** What the name and login boxes show as their hint: typed, else detected. */
  shownOwner(): string;
  shownGithub(): string;
  /** A detection nobody confirmed, with the evidence it found ("" when none). */
  check(): { why: string } | null;
  /** "Last run 2m ago (rules only: ...)" or "Not run yet.". */
  detectedStatus(): string;
  detecting(): boolean;
  pcs(): Pc[];
  confirm(): void;
  detect(): void;
  /** The owner or a flag changed: the mesh and the phones hear about it. */
  changed(): void;
}

/** SSH defaults, the device list and its editor (remoteui.rs). */
export interface SshHost {
  config(): RemoteConfig;
  save(c: RemoteConfig): void;
  /** Configured devices, then found PCs; with whether each is online. */
  devices(): [RemoteHost, boolean | null][];
  probe(id: string): RemoteProbe | null;
  /** The user ssh uses for it, and whether ~/.ssh/config says so. */
  login(h: RemoteHost): [string, boolean] | null;
  sshPort(h: RemoteHost): number;
  /** PCs to add in one click (the ones that aren't devices yet). */
  offers(): NearbyPc[];
  /** The name of the home folder, the hint of the User box. */
  homeName(): string;
  test(h: RemoteHost): void;
  /** Adds a device by hand and tests it; returns its id. */
  add(name: string, host: string, user: string, port: number): string;
  removeIcon(id: string): void;
  pickImage(h: RemoteHost): void;
  terminal(h: RemoteHost, command: string | null): void;
}

export interface DevicesHost {
  kv: Kv;
  now(): number;
  mesh: MeshHost;
  pair: PairHost;
  outside: OutsideHost;
  people: PeopleHost;
  ssh: SshHost;
}

/** What the tab keeps between redraws. */
export interface DevicesState {
  shareMenu: string | null;
  /** Peer id to [its version when asked, when (unix s)]. */
  updating: Map<string, [string, number]>;
  open: string | null;
  pairAddr: string;
  /** A line of the pairing card that isn't the host's result (a found PC picked to pair). */
  pairNote: { ok: boolean; text: string } | null;
}

export const newDevicesState = (): DevicesState => ({ shareMenu: null, updating: new Map(), open: null, pairAddr: "", pairNote: null });

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {});
const upd = (p: Peer, k: string): unknown => record(p.update)[k];
const updText = (p: Peer, k: string): string => {
  const v = upd(p, k);
  return typeof v === "string" ? v : "";
};

const onUnless0 = (kv: Kv, k: string) => kv.get(k) !== "0";

/** The PCs worth a row: allowed ones, Harbors met, linked peers, then those heard on the network. */
function pcKeys(h: MeshHost): [string, string][] {
  const keys: [string, string][] = h.allowed().map((a) => [allowedKey(a), a.name === "" ? peerLabel(a.id) : a.name]);
  const add = (k: string, name: string) => {
    if (!keys.some(([n]) => n === k)) keys.push([k, name]);
  };
  for (const s of h.seen().values()) add(s.fp === "" ? s.node : s.fp, s.name);
  for (const p of h.peers()) add(p.fp !== "" ? p.fp : p.node !== "" ? p.node : p.id, p.name);
  for (const l of h.lan()) add(l.fp, l.name);
  return keys;
}

/** The newest Harbor this PC or any peer knows of. */
function newestVersion(h: MeshHost): string {
  let newest = h.ownVersion();
  const peers = h.peers();
  for (const v of [h.ownLatest(), ...peers.flatMap((p) => [p.version, updText(p, "latest")])]) if (versionNewer(v, newest)) newest = v;
  return newest;
}

const ago = (t: number, now: number) => (agoShort(t, now) === "now" ? "just now" : `${agoShort(t, now)} ago`);

function peerRow(h: DevicesHost, st: DevicesState, key: string, name: string, newest: string): BlockRow[] {
  const m = h.mesh;
  const now = h.now();
  const me = m.me();
  const peers = m.peers();
  const lan = m.lan();
  const seen = m.seen();
  const allowed = m.allowed();
  const byFp = normalizeFp(key) !== null;
  const peer = peers.find((p) => (p.fp !== "" && p.fp === key) || (p.node !== "" && p.node === key) || p.id === key);
  const s = seen.get(key);
  const entry = allowed.find((a) => allowedKey(a) === key);
  const listed = entry !== undefined;
  const auto = !listed && peer !== undefined;
  const known = listed || auto;
  const busy = (p: Peer) => st.updating.has(p.id) || upd(p, "installing") === true || upd(p, "checking") === true;
  const behind = (p: Peer) => p.online && upd(p, "managed") === true && versionNewer(newest, p.version);
  const asks = (p: Peer) => p.online && upd(p, "managed") === true && upd(p, "auto") === false;
  let badgeOf: BlockBadge;
  if (peer?.online) badgeOf = badge("Sharing", "green");
  else if (known && s?.refuses) badgeOf = badge("Waiting", "amber");
  else if (known) badgeOf = badge("Off");
  else badgeOf = badge("Not paired");
  let desc: string;
  if (peer?.online) {
    const status = st.updating.has(peer.id) ? "updating…" : updText(peer, "status");
    desc = `Harbor ${peer.version}`;
    if (status !== "") desc += ` · ${status}`;
    if (behind(peer) && !busy(peer) && !status.includes(newest)) desc += ` · ${newest} is out`;
    if (upd(peer, "managed") === true && upd(peer, "auto") === true) desc += " · updates automatically";
  } else if (known && s?.refuses) desc = `Allowed here, but ${name} doesn't allow ${me.name} (pair them again)`;
  else if (known && peer && peer.seen > 0) {
    desc = `Last seen ${ago(peer.seen, now)}`;
    if (peer.version !== "") desc += ` · Harbor ${peer.version}`;
  } else if (known) desc = "Allowed · not answering (off, or Harbor isn't sharing there)";
  else if (s !== undefined && s.asked > 0) desc = "Asks to share chats with this PC: pair it with a code to allow it";
  else desc = "Runs Harbor with sharing on";
  const heard = lan.find((l) => l.fp === key);
  if (heard) desc = `On this network at ${heard.addr} · Harbor ${heard.version} · pair it with a code`;
  if (byFp) desc += ` · key ${keyShort(key)}`;
  else if ((entry !== undefined && entry.node !== "") || (s !== undefined && s.node !== "")) desc += " · on Tailscale, switches to its own key once both PCs have Harbor 0.13";
  const phonesOff = peer !== undefined && peer.online && !peer.phones;
  if (phonesOff) desc += " · phone access off: your phone can't use it when this PC is off";
  if (peer) {
    const n = m.chatsCopied(peer.id);
    if (n === 1) desc += " · 1 chat copied here";
    else if (n > 1) desc += ` · ${n} chats copied here`;
    if (peer.owner !== "") desc += ` · owner ${peer.owner}`;
  }
  const buttons = [];
  if (peer) {
    const level = m.shareLevel(peer.id);
    buttons.push(btn(`share:${peer.id}`, machines.short(level), { icon: ICONS.FOLDER, tip: "What chats from this PC may do with this PC's files, shell and GitHub", on: st.shareMenu === peer.id }));
  }
  const real = !key.includes(":");
  if (real && listed) buttons.push(btn(`remove:${key}`, "Remove", { variant: "destructive" }));
  if (real && !byFp && !listed && !auto) buttons.push(btn(`allow:${key}`, "Allow", { variant: "primary" }));
  if (heard && !listed) buttons.push(btn(`pairlan:${heard.fp}`, "Pair", { variant: "primary" }));
  if (peer && behind(peer)) {
    const b = busy(peer);
    buttons.push(btn(`update:${peer.id}`, b ? "Updating…" : "Update", { variant: "primary", enabled: !b, tip: `Install Harbor ${newest} there; it reloads in place, its running agents keep going` }));
  }
  if (peer && asks(peer)) {
    buttons.push(btn(`autoupdate:${peer.id}`, "Auto-update", { tip: "Turn on Settings › Updates › Automatically there: new versions install in the background and swap in while nobody uses Harbor on it" }));
  }
  if (phonesOff && peer) buttons.push(btn(`phones:${peer.id}`, "Enable phone access"));
  const out = [row(name, { icon: ICONS.MONITOR, desc, badges: [badgeOf], buttons: buttons.reverse() })];
  if (peer && st.shareMenu === peer.id) {
    const cur = m.shareLevel(peer.id);
    out.push(row("Its chats may", { desc: machines.aboutLevel(cur), buttons: machines.LEVELS.map((l) => btn(`level:${peer.id}:${l}`, machines.label(l), { on: l === cur })) }));
  }
  return out;
}

/** meshctx.rs `mesh_settings`: the "Your PCs" card. */
function yourPcs(h: DevicesHost, st: DevicesState): Block[] {
  const m = h.mesh;
  const on = m.on();
  const me = m.me();
  const peers = m.peers();
  const newest = newestVersion(m);
  const busy = (p: Peer) => st.updating.has(p.id) || upd(p, "installing") === true || upd(p, "checking") === true;
  const behindAll = peers.filter((p) => p.online && upd(p, "managed") === true && versionNewer(newest, p.version) && !busy(p));
  const asksAll = peers.filter((p) => p.online && upd(p, "managed") === true && upd(p, "auto") === false);
  const self = [btn("copy_key", "", { icon: ICONS.COPY, variant: "muted", tip: "Copy this PC's full key" })];
  if (on && behindAll.length > 1) self.push(btn("update_all", "Update all PCs", { tip: "Install the newest Harbor on every other PC that's behind" }));
  if (on && asksAll.length > 0) self.push(btn("auto_all", "Auto-update all PCs", { tip: "Settings › Updates › Automatically on this PC and every other one: new versions install in the background and swap in while nobody uses Harbor there" }));
  if (on && !m.phonesOn()) self.push(btn("phones_here", "Enable phone access"));
  const lines: BlockRow[] = [
    row("Share chats with my other PCs", {
      desc: "Every PC with Harbor and this on keeps a copy of every chat and can write in any of them; the agent runs on the PC the chat was started on. Your phone keeps working through any PC that's on. Pair two PCs once with a code (below); they talk over your network, encrypted, and only with each other's keys.",
      key: "mesh_on",
      control: "toggle",
      on,
    }),
    row(`${me.name} (this PC)`, { icon: ICONS.MONITOR, desc: `Harbor ${m.versionLabel()} · key ${keyShort(m.myFp())}`, buttons: self.reverse() }),
  ];
  const port = m.port();
  if (on && m.firewallBlocks(port)) {
    lines.push(row("The firewall blocks your other PCs", { desc: `This PC's firewall (ufw) drops port ${port}, so other PCs and phones on the network can't reach Harbor here.`, buttons: [btn("fix_firewall", "Allow on the local network", { variant: "primary" })] }));
  }
  if (on) {
    const keys = pcKeys(m);
    for (const [key, name] of keys) lines.push(...peerRow(h, st, key, name, newest));
    if (keys.length === 0) lines.push(row("No other PCs yet", { desc: "Turn this on in Harbor on your other PC too, then pair them with a code below." }));
  }
  return [title("Your PCs", 11), rows(lines)];
}

/** meshctx.rs `mesh_pair_ui`. */
function pairBlocks(h: DevicesHost, st: DevicesState): Block[] {
  const code = h.pair.shown();
  const now = h.now();
  let first: BlockRow;
  const out: Block[] = [title("Pair a PC")];
  const extra: Block[] = [];
  if (code !== null && code.paired !== "") {
    first = row(`Paired with ${code.paired}`, { desc: "Both PCs allow each other now: their chats show up here in a moment.", buttons: [btn("pair_cancel", "Done")] });
  } else if (code !== null && (code.tries >= CODE_TRIES || code.expires <= now)) {
    first = row(code.tries >= CODE_TRIES ? "Too many wrong tries: the code is void." : "The code ran out.", { desc: "Show a new one to pair.", buttons: [btn("pair_show", "New code", { variant: "primary" })] });
  } else if (code !== null) {
    const left = Math.max(code.expires - now, 0);
    const addrs = h.mesh.addrs();
    first = row(`Code  ${code.code}`, {
      desc: `On the other PC: Settings › Devices › Enter a code, with this PC's address ${addrs[0] ?? "(no network)"} · good for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more, once`,
      badges: [badge("Waiting", "amber")],
      buttons: [btn("pair_cancel", "Cancel")],
    });
    if (addrs.length > 1) extra.push(copy(`This PC's other addresses: ${addrs.slice(1).join("  ")}`, 12, { before: 8 }));
  } else {
    first = row("Show a code", { desc: "Shows a one-time code here to type on your other PC.", buttons: [btn("pair_show", "Show a code", { variant: "primary" })] });
  }
  out.push(rows([first]), ...extra);
  const busy = h.pair.busy();
  const note = st.pairNote ?? h.pair.result();
  out.push(
    form("pair", [field("addr", "Its address (e.g. 10.0.0.12)", { width: 200, min: 1, text: st.pairAddr }), field("code", "Code", { mono: true, width: 140, min: 10 })], btn("pair", busy ? "Pairing…" : "Pair", { variant: "primary", enabled: !busy }), {
      before: 16,
      frame: "header",
      title: "Enter a code",
      desc: "The address and code another PC shows under Show a code.",
    }),
  );
  if (note) out.push(copy(note.ok ? note.text : `Not paired: ${note.text}`, 13, { before: 8 }));
  return out;
}

/** meshctx.rs `people_ui`. */
function peopleBlocks(h: DevicesHost): Block[] {
  const kv = h.kv;
  const p = h.people;
  const shownOwner = p.shownOwner();
  const shownGh = p.shownGithub();
  const lines: BlockRow[] = [];
  const check = p.check();
  if (check) {
    const who = shownGh === "" ? shownOwner : `${shownOwner} · GitHub ${shownGh}`;
    const why = check.why === "" ? "" : ` ${check.why.replace(/\.+$/, "")}.`;
    lines.push(row("Detected, confirm?", { desc: `${who}.${why} Agents and your other PCs see it as this PC's owner.`, buttons: [btn("confirm_owner", "Confirm", { variant: "primary" }), btn("edit_owner", "Edit")] }));
  }
  lines.push(
    row("Your name", { desc: "How this PC's owner shows to agents and to your other PCs (who is who). Empty: the detected name.", key: OWNER_KEY, control: "input", text: kv.get(OWNER_KEY) ?? "", hint: shownOwner, width: 200 }),
    row("Your GitHub login", { desc: "Empty: the detected login, else the account signed in under Settings › Integrations › Apps.", key: GITHUB_KEY, control: "input", text: kv.get(GITHUB_KEY) ?? "", hint: shownGh, width: 160 }),
    row("Detect who is who", {
      desc: `Reads names and logins on this PC (git, gh, agent accounts, phones, SSH hosts and key comments, CLAUDE.md; never keys or tokens) and asks this PC's own Claude account for each PC's owner. A name you typed always stays. ${p.detecting() ? "Detecting…" : p.detectedStatus()}`,
      buttons: [btn("detect", "Detect again", { enabled: !p.detecting() })],
    }),
    row("Send my instructions and memory", {
      desc: "A chat you drive from here that runs on another PC uses your global CLAUDE.md, your memory of its project and your language settings instead of that PC owner's, and memory it saves comes back here. Off: it runs with no user instructions or memory at all.",
      key: SEND_KEY,
      control: "toggle",
      on: onUnless0(kv, SEND_KEY),
    }),
    row("My chats on other PCs may use my GitHub here", {
      desc: "A chat you drive from here that runs on another PC can run gh on this PC with Harbor's GitHub sign-in, so its issues and pull requests are yours. Off: only PCs you let do everything (Its chats may, above) get it.",
      key: machines.GITHUB_KEY,
      control: "toggle",
      on: onUnless0(kv, machines.GITHUB_KEY),
    }),
  );
  const pcs = p.pcs();
  if (pcs.length > 1) {
    for (const pc of pcs) lines.push(row(`${pc.name}${pc.me ? " (this PC)" : ""}`, { icon: ICONS.MONITOR, desc: pc.why === "" ? peoplePcLine(pc) : `${peoplePcLine(pc)}\n${pc.why}` }));
  }
  return [title("People and memory"), rows(lines)];
}

const dev = (key: string, hint: string, text: string, p: Partial<BlockField> = {}) => field(key, hint, { text, ...p });

function editor(h: DevicesHost, d: RemoteHost): BlockEdit[] {
  const ssh = h.ssh;
  const id = d.id;
  const shown: RemoteHost = { ...d, user: "", port: 0 };
  const login = ssh.login(shown);
  const userHint = login === null ? "default" : login[1] ? `${login[0]} (from ~/.ssh/config)` : login[0];
  const portHint = ssh.sshPort(shown) === 0 ? "port" : String(ssh.sshPort(shown));
  const here = !d.device_files;
  const icons = [btn(`devicon:${id}:`, "Auto", { on: d.icon === "" }), ...DEVICE_ICONS.map(([name, g]) => btn(`devicon:${id}:${name}`, "", { icon: g, variant: "muted", tip: name, on: d.icon === name })), btn(`devicon:${id}:file`, "Image…", { icon: ICONS.IMAGE, on: d.icon === "file" })];
  const out: BlockEdit[] = [
    { kind: "field", label: "Name", fields: [dev(`d:${id}:name`, d.host, d.name)], buttons: [], toggles: [], text: "" },
    { kind: "field", label: "Address", fields: [dev(`d:${id}:host`, "host, IP or ssh alias", d.host, { mono: true })], buttons: [], toggles: [], text: "" },
    { kind: "field", label: "User · port", fields: [dev(`d:${id}:user`, userHint, d.user, { mono: true, width: 230 }), dev(`d:${id}:port`, portHint, d.port === 0 ? "" : String(d.port), { mono: true, width: 80 })], buttons: [], toggles: [], text: "" },
    { kind: "field", label: "Folder", fields: [dev(`d:${id}:dir`, "mirrors this PC's project path", d.dir, { mono: true })], buttons: [], toggles: [], text: "" },
    { kind: "icons", label: "Icon", fields: [], buttons: icons, toggles: [], text: "" },
    {
      kind: "toggles",
      label: "",
      fields: [],
      buttons: [],
      toggles: [
        { key: `dt:${id}:shown`, label: "In the composer", on: !d.hidden, tip: "" },
        { key: `dt:${id}:bridge`, label: "MCP bridge", on: d.bridge, tip: "This PC's MCP servers and signed-in apps, through the ssh connection" },
        { key: `dt:${id}:commands`, label: "Commands on this PC", on: d.commands, tip: "A run_command tool: the agent there can run shell commands on this PC" },
      ],
      text: "",
    },
    {
      kind: "toggles",
      label: "",
      fields: [],
      buttons: [],
      toggles: [{ key: `dt:${id}:here`, label: "Work on this PC's files (shell, git and files run here)", on: here, tip: "The agent there edits, builds and commits this PC's project: its shell, git and file tools run here (in the chat's mode). Off: it works on the device's own copy" }],
      text: "",
    },
  ];
  if (d.commands || here) {
    out.push({ kind: "warn", label: "", fields: [], buttons: [], toggles: [], text: `The agent on ${hostLabel(d)} can run any command${here ? " and change any file" : ""} on this PC, as you.` });
  }
  out.push({ kind: "buttons", label: "", fields: [], buttons: [btn(`terminal:${id}`, "Terminal there", { icon: ICONS.TERMINAL }), btn(`claude:${id}`, "Sign in to Claude there", { variant: "ghost" })], toggles: [], text: "" });
  return out;
}

function deviceRows(h: DevicesHost, st: DevicesState, devs: [RemoteHost, boolean | null][]): BlockRow[] {
  const ssh = h.ssh;
  return devs.map(([d, online]) => {
    const probe = ssh.probe(d.id);
    const open = st.open === d.id;
    const badges: BlockBadge[] = [badge(isFound(d) ? "Your PC" : "SSH")];
    if (online === true) badges.push(badge("Online", "green"));
    else if (online === false) badges.push(badge("Offline"));
    if (d.hidden) badges.push(badge("Hidden", "amber"));
    const os = d.os === "" ? "" : ` · ${osLabel(d.os)}`;
    const login = ssh.login(d);
    const user = login === null ? "" : `${login[0]}@`;
    let note = "";
    let tone: BlockRow["note_tone"] = "";
    if (probe) {
      note = probe.text;
      tone = probe.ok === true ? (probe.text.includes("claude ") ? "green" : "amber") : probe.ok === false ? "red" : "";
    }
    const found = isFound(d);
    return row(hostLabel(d), {
      mark: glyph(d),
      lead: 22,
      badges,
      line: `${user}${d.host}${os}`,
      note,
      note_tone: tone,
      well: true,
      buttons: [
        btn(`test:${d.id}`, "Test", { enabled: probe?.running !== true }),
        btn(`edit:${d.id}`, open ? "Done" : "Edit", { variant: "ghost" }),
        btn(found ? `hide:${d.id}` : `drop:${d.id}`, found ? (d.hidden ? "Show" : "Hide") : "Remove", { variant: found ? "ghost" : "destructive" }),
      ],
      edit: open ? editor(h, d) : [],
    });
  });
}

function sshBlocks(h: DevicesHost, st: DevicesState): Block[] {
  const ssh = h.ssh;
  const cfg = ssh.config();
  const devs = ssh.devices();
  const offers = ssh.offers();
  const out: Block[] = [
    title("SSH"),
    rows([
      row("User", { desc: "Your user on the devices. Empty: ssh's default (your ~/.ssh/config, or this PC's user).", key: "ssh:user", control: "input", text: cfg.user, hint: ssh.homeName(), width: 180 }),
      row("Key", { desc: "Identity file. Empty: ssh's own keys and agent.", key: "ssh:key", control: "input", text: cfg.key, hint: "~/.ssh/id_ed25519", mono: true, width: 220 }),
      row("Port", { desc: "Empty: 22, or what ~/.ssh/config says.", key: "ssh:port", control: "input", text: cfg.port === 0 ? "" : String(cfg.port), hint: "22", mono: true, width: 80 }),
    ]),
    title("Devices"),
    list(deviceRows(h, st, devs), "None yet. PCs you pair with this one appear here by themselves; add any other one by SSH below."),
    title("Add a device by SSH"),
    form("ssh_add", [field("name", "Name", { width: 140 }), field("host", "host, IP or ssh alias", { mono: true, width: 200, min: 1 }), field("user", "user (optional)", { mono: true, width: 130 })], btn("ssh_add", "Add", { icon: ICONS.PLUS, variant: "primary" }), {
      frame: "card",
      chips_title: offers.length > 0 ? "On your network and in ~/.ssh/config" : "",
      chips: offers.map((n) => btn(`offer:${n.host}`, n.name, { icon: ICONS.PLUS, tip: `Add ${n.host} (${n.source}) and test it` })),
    }),
    copy(
      "A chat picks its device in the composer and stays on it. The agent works in that PC's folder (a project's path is mirrored there unless the device sets a folder) as the chat's Claude account (its login is sent along; the device's own login is used only when the account isn't signed in on this PC), and pushes through its own git. Any PC works: Linux, macOS (Remote Login on) or Windows (OpenSSH Server on), with or without Harbor. It needs Claude Code and key-based ssh; nothing else is installed on it, and Tailscale is optional.",
      12,
      { before: 12 },
    ),
    copy(
      "The MCP bridge runs this PC's MCP servers and apps here and forwards them to the device over the same ssh connection (ssh -R), so their sign-ins never leave this PC. Your slash commands and skills come along as prompts of the `origin` server. Harbor's processes still start on this PC. A turn ends if the connection drops.",
      12,
      { before: 12 },
    ),
  ];
  return out;
}

/** remoteui.rs `devices_tab`, with mesh.rs `mesh_settings`. */
export function devicesBlocks(h: DevicesHost, st: DevicesState): Block[] {
  const out = [...yourPcs(h, st), ...pairBlocks(h, st)];
  if (h.mesh.on()) out.push(...outsideBlocks(h.outside));
  out.push(...peopleBlocks(h), ...sshBlocks(h, st));
  return out;
}

/** The tab's controls over `host`. */
export function devicesTab(host: DevicesHost): BlockTab {
  const st = newDevicesState();
  const m = host.mesh;
  const ssh = host.ssh;
  const patch = (id: string, f: (d: RemoteHost) => RemoteHost): void => {
    const cfg = ssh.config();
    const cur = cfg.devices.find((d) => d.id === id) ?? ssh.devices().find(([d]) => d.id === id)?.[0];
    if (!cur) return;
    const next = f({ ...cur });
    const devices = cfg.devices.some((d) => d.id === id) ? cfg.devices.map((d) => (d.id === id ? next : d)) : [...cfg.devices, next];
    ssh.save({ ...cfg, devices });
  };
  const peerById = (id: string) => m.peers().find((p) => p.id === id);
  const forget = () => {
    const now = host.now();
    const peers = m.peers();
    for (const [id, [was, at]] of st.updating) if (now - at >= UPDATING_SECS || !peers.some((p) => p.id === id && p.version === was)) st.updating.delete(id);
  };
  const pressed = (key: string): void => {
    forget();
    const at = key.indexOf(":");
    const verb = at < 0 ? key : key.slice(0, at);
    const rest = at < 0 ? "" : key.slice(at + 1);
    if (outsidePressed(host.outside, key)) return;
    switch (verb) {
      case "copy_key":
        m.copy(m.myFp());
        return;
      case "fix_firewall":
        m.openFirewall();
        return;
      case "phones_here":
        m.setPhonesOn(true);
        return;
      case "update_all":
      case "auto_all": {
        const newest = newestVersion(m);
        const idle = (p: Peer) => !st.updating.has(p.id) && upd(p, "installing") !== true && upd(p, "checking") !== true;
        const ps = m.peers().filter((p) => (verb === "update_all" ? p.online && upd(p, "managed") === true && versionNewer(newest, p.version) && idle(p) : p.online && upd(p, "managed") === true && upd(p, "auto") === false));
        if (verb === "update_all") {
          for (const p of ps) st.updating.set(p.id, [p.version, host.now()]);
          m.updatePeers(ps);
        } else {
          host.kv.set("auto_update", "1");
          m.autoUpdatePeers(ps);
        }
        return;
      }
      case "update": {
        const p = peerById(rest);
        if (p) {
          st.updating.set(p.id, [p.version, host.now()]);
          m.updatePeers([p]);
        }
        return;
      }
      case "autoupdate": {
        const p = peerById(rest);
        if (p) m.autoUpdatePeers([p]);
        return;
      }
      case "phones": {
        const p = peerById(rest);
        if (p) m.enablePhonesOn(p);
        return;
      }
      case "share":
        st.shareMenu = st.shareMenu === rest ? null : rest;
        return;
      case "level": {
        const i = rest.lastIndexOf(":");
        const l = machines.parseLevel(rest.slice(i + 1));
        if (i > 0 && l !== null) m.setShareLevel(rest.slice(0, i), l);
        st.shareMenu = null;
        return;
      }
      case "remove":
      case "allow": {
        const name = pcKeys(m).find(([k]) => k === rest)?.[1] ?? "";
        m.allow(rest, name, verb === "allow");
        return;
      }
      case "pairlan": {
        const l = m.lan().find((x) => x.fp === rest);
        if (l) {
          st.pairAddr = l.addr;
          st.pairNote = { ok: true, text: `Now show a code on ${l.name} (Settings › Devices › Show a code) and type it below.` };
        }
        return;
      }
      case "pair_show": {
        const e = host.pair.show();
        if (e === null) {
          st.pairNote = null;
          m.setOn(true);
        } else st.pairNote = { ok: false, text: `no code: ${e}` };
        return;
      }
      case "pair_cancel":
        host.pair.cancel();
        return;
      case "confirm_owner":
        host.people.confirm();
        return;
      case "edit_owner":
        host.kv.set(OWNER_KEY, host.people.shownOwner());
        host.kv.set(GITHUB_KEY, host.people.shownGithub());
        host.people.changed();
        return;
      case "detect":
        host.people.detect();
        return;
      case "test": {
        const d = ssh.devices().find(([x]) => x.id === rest)?.[0];
        if (d) ssh.test(d);
        return;
      }
      case "edit":
        st.open = st.open === rest ? null : rest;
        return;
      case "hide":
        patch(rest, (d) => ({ ...d, hidden: !d.hidden }));
        return;
      case "drop": {
        const cfg = ssh.config();
        ssh.save({ ...cfg, devices: cfg.devices.filter((d) => d.id !== rest) });
        ssh.removeIcon(rest);
        return;
      }
      case "devicon": {
        const i = rest.lastIndexOf(":");
        const id = rest.slice(0, i);
        const name = rest.slice(i + 1);
        if (name === "file") {
          const d = ssh.devices().find(([x]) => x.id === id)?.[0];
          if (d) ssh.pickImage(d);
        } else patch(id, (d) => ({ ...d, icon: name }));
        return;
      }
      case "terminal":
      case "claude": {
        const d = ssh.devices().find(([x]) => x.id === rest)?.[0];
        if (d) ssh.terminal(d, verb === "claude" ? "claude /login" : null);
        return;
      }
      case "offer": {
        const n = ssh.offers().find((o) => o.host === rest);
        if (n) st.open = ssh.add(n.name === n.host ? "" : n.name, n.host, n.user, n.port);
        return;
      }
    }
  };
  return {
    blocks: () => {
      forget();
      return devicesBlocks(host, st);
    },
    pressed,
    toggled(key, on) {
      if (outsideToggled(host.outside, key, on)) return;
      if (key === "mesh_on") m.setOn(on);
      else if (key === SEND_KEY || key === machines.GITHUB_KEY) {
        host.kv.set(key, on ? "1" : "0");
        host.people.changed();
      } else if (key.startsWith("dt:")) {
        const i = key.lastIndexOf(":");
        const id = key.slice(3, i);
        const what = key.slice(i + 1);
        patch(id, (d) => (what === "shown" ? { ...d, hidden: !on } : what === "bridge" ? { ...d, bridge: on } : what === "commands" ? { ...d, commands: on } : { ...d, device_files: !on }));
      }
    },
    edited(key, text) {
      if (outsideEdited(host.outside, key, text)) return;
      if (key === OWNER_KEY || key === GITHUB_KEY) {
        host.kv.set(key, text);
        host.people.changed();
      } else if (key.startsWith("ssh:")) {
        const cfg = ssh.config();
        const n = Number(text.trim());
        const what = key.slice(4);
        ssh.save(what === "user" ? { ...cfg, user: text } : what === "key" ? { ...cfg, key: text } : { ...cfg, port: Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0 });
      } else if (key.startsWith("d:")) {
        const i = key.lastIndexOf(":");
        const id = key.slice(2, i);
        const what = key.slice(i + 1);
        const n = Number(text.trim());
        patch(id, (d) => (what === "name" ? { ...d, name: text } : what === "host" ? { ...d, host: text } : what === "user" ? { ...d, user: text } : what === "dir" ? { ...d, dir: text } : { ...d, port: Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0 }));
      }
    },
    submitted(key, values) {
      if (key === "pair") {
        st.pairAddr = (values[0] ?? "").trim();
        st.pairNote = null;
        m.setOn(true);
        host.pair.join(st.pairAddr, values[1] ?? "");
      } else if (key === "ssh_add") {
        const address = (values[1] ?? "").trim();
        if (address !== "") st.open = ssh.add((values[0] ?? "").trim(), address, (values[2] ?? "").trim(), 0);
      }
      return "";
    },
  };
}
