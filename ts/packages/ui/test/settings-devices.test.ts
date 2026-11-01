import { describe, expect, test } from "bun:test";
import { GITHUB_KEY, MemKv, newHost, newPeer, OWNER_KEY, SEND_KEY, type Allowed, type PairCode, type Peer, type RemoteConfig, type RemoteHost, type Seen } from "@harbor/net";
import { machines } from "@harbor/mcp";
import { devicesBlocks, devicesTab, newDevicesState, type DevicesHost, type LanPc } from "../src/logic/settings-devices.ts";
import type { Block, BlockRow } from "../src/logic/settings-blocks.ts";

const NOW = 100_000;
const MINE = "a".repeat(64);
const FP_B = "b".repeat(64);

interface Fake extends DevicesHost {
  calls: string[];
  state: { on: boolean; phones: boolean; peers: Peer[]; allowed: Allowed[]; seen: Map<string, Seen>; lan: LanPc[]; code: PairCode | null; cfg: RemoteConfig; devices: [RemoteHost, boolean | null][]; levels: Map<string, machines.Level>; addrs: string[]; owner: string; github: string; firewall: boolean };
}

function fake(): Fake {
  const kv = new MemKv();
  const calls: string[] = [];
  const state: Fake["state"] = { on: true, phones: true, peers: [], allowed: [], seen: new Map(), lan: [], code: null, cfg: { tailscale: true, user: "", key: "", port: 0, devices: [] }, devices: [], levels: new Map(), addrs: ["198.51.100.5:47930"], owner: "Ana", github: "ana", firewall: false };
  const h: Fake = {
    kv,
    now: () => NOW,
    calls,
    state,
    mesh: {
      on: () => state.on,
      setOn: (on) => {
        state.on = on;
        calls.push(`mesh ${on}`);
      },
      me: () => ({ id: "pc:desk", name: "desk" }),
      myFp: () => MINE,
      versionLabel: () => "0.50.0 (abc)",
      ownVersion: () => "0.50.0",
      ownLatest: () => "",
      peers: () => state.peers,
      allowed: () => state.allowed,
      seen: () => state.seen,
      lan: () => state.lan,
      chatsCopied: (id) => (id === "pc:lap" ? 2 : 0),
      phonesOn: () => state.phones,
      setPhonesOn: (on) => void calls.push(`phones ${on}`),
      port: () => 47930,
      firewallBlocks: () => state.firewall,
      openFirewall: () => void calls.push("firewall"),
      addrs: () => state.addrs,
      allow: (k, n, a) => void calls.push(`allow ${k} ${n} ${a}`),
      shareLevel: (id) => state.levels.get(id) ?? "full",
      setShareLevel: (id, l) => void calls.push(`level ${id} ${l}`),
      updatePeers: (ps) => void calls.push(`update ${ps.map((p) => p.id).join(",")}`),
      autoUpdatePeers: (ps) => void calls.push(`auto ${ps.map((p) => p.id).join(",")}`),
      enablePhonesOn: (p) => void calls.push(`enable ${p.id}`),
      copy: (t) => void calls.push(`copy ${t}`),
    },
    pair: {
      shown: () => state.code,
      show: () => {
        calls.push("show");
        return null;
      },
      cancel: () => void calls.push("cancel"),
      busy: () => false,
      join: (a, c) => void calls.push(`join ${a} ${c}`),
      result: () => null,
    },
    outside: { kv, port: () => 47930, summary: () => [], firewallBlocksInternet: () => false, openInternetFix: () => {} },
    people: {
      shownOwner: () => state.owner,
      shownGithub: () => state.github,
      check: () => null,
      detectedStatus: () => "Not run yet.",
      detecting: () => false,
      pcs: () => [],
      confirm: () => void calls.push("confirm"),
      detect: () => void calls.push("detect"),
      changed: () => void calls.push("changed"),
    },
    ssh: {
      config: () => state.cfg,
      save: (c) => {
        state.cfg = c;
        calls.push("save");
      },
      devices: () => state.devices,
      probe: () => null,
      login: (d) => (d.user !== "" ? [d.user, false] : null),
      sshPort: (d) => d.port,
      offers: () => [],
      homeName: () => "ana",
      test: (d) => void calls.push(`test ${d.id}`),
      add: (name, host, user, port) => {
        calls.push(`add ${name}|${host}|${user}|${port}`);
        return "ssh:1";
      },
      removeIcon: (id) => void calls.push(`icon ${id}`),
      pickImage: (d) => void calls.push(`image ${d.id}`),
      terminal: (d, c) => void calls.push(`terminal ${d.id} ${c ?? ""}`),
    },
  };
  return h;
}

const peer = (p: Partial<Peer> & { id: string }): Peer => newPeer({ name: p.id, fp: FP_B, online: true, version: "0.50.0", phones: true, ...p });
const yourPcs = (b: Block[]): BlockRow[] => b.find((x) => x.kind === "rows")?.rows ?? [];
const titles = (b: Block[]) => b.filter((x) => x.kind === "title").map((x) => x.title);
const keysOf = (r: BlockRow | undefined) => r?.buttons.map((x) => x.key) ?? [];

describe("meshctx.rs mesh_settings", () => {
  test("off_shows_the_toggle_and_this_pc_only", () => {
    const h = fake();
    h.state.on = false;
    const b = devicesBlocks(h, newDevicesState());
    expect(titles(b)).toEqual(["Your PCs", "Pair a PC", "People and memory", "SSH", "Devices", "Add a device by SSH"]);
    const rows = yourPcs(b);
    expect(rows.map((r) => r.title)).toEqual(["Share chats with my other PCs", "desk (this PC)"]);
    expect(rows[0]).toMatchObject({ control: "toggle", on: false, key: "mesh_on" });
    expect(rows[1]?.desc).toBe("Harbor 0.50.0 (abc) · key aaaa aaaa aaaa aaaa");
    expect(keysOf(rows[1])).toEqual(["copy_key"]);
  });

  test("on_without_peers_says_none_yet", () => {
    const b = devicesBlocks(fake(), newDevicesState());
    expect(yourPcs(b).at(-1)).toMatchObject({ title: "No other PCs yet", desc: "Turn this on in Harbor on your other PC too, then pair them with a code below." });
    expect(titles(b)).toContain("From outside your network");
  });

  test("this_pc_offers_phone_access_and_the_firewall_fix", () => {
    const h = fake();
    h.state.phones = false;
    h.state.firewall = true;
    const rows = yourPcs(devicesBlocks(h, newDevicesState()));
    expect(keysOf(rows[1])).toEqual(["phones_here", "copy_key"]);
    expect(rows[2]).toMatchObject({ title: "The firewall blocks your other PCs" });
    expect(rows[2]?.desc).toContain("port 47930");
    const t = devicesTab(h);
    t.pressed("phones_here");
    t.pressed("fix_firewall");
    t.pressed("copy_key");
    expect(h.calls).toEqual(["phones true", "firewall", `copy ${MINE}`]);
  });

  test("a_linked_peer_is_sharing_with_its_version_and_chats", () => {
    const h = fake();
    h.state.peers = [peer({ id: "pc:lap", name: "laptop", owner: "Leo" })];
    const row = yourPcs(devicesBlocks(h, newDevicesState())).find((r) => r.title === "laptop");
    expect(row?.badges).toEqual([{ text: "Sharing", tone: "green" }]);
    expect(row?.desc).toBe(`Harbor 0.50.0 · key ${"bbbb bbbb bbbb bbbb"} · 2 chats copied here · owner Leo`);
    expect(row?.buttons.map((x) => [x.key, x.label, x.icon !== ""])).toEqual([["share:pc:lap", "Everything", true]]);
  });

  test("an_allowed_pc_that_is_off_shows_last_seen_and_can_be_removed", () => {
    const h = fake();
    h.state.allowed = [{ node: "", name: "laptop", fp: FP_B, id: "pc:lap", addrs: [] }];
    h.state.peers = [peer({ id: "pc:lap", name: "laptop", online: false, seen: NOW - 7200 })];
    const row = yourPcs(devicesBlocks(h, newDevicesState())).find((r) => r.title === "laptop");
    expect(row?.badges[0]).toEqual({ text: "Off", tone: "gray" });
    expect(row?.desc).toBe(`Last seen 2h ago · Harbor 0.50.0 · key ${"bbbb bbbb bbbb bbbb"} · 2 chats copied here`);
    expect(keysOf(row)).toEqual([`remove:${FP_B}`, "share:pc:lap"]);
    devicesTab(h).pressed(`remove:${FP_B}`);
    expect(h.calls).toEqual([`allow ${FP_B} laptop false`]);
  });

  test("an_allowed_pc_with_no_peer_is_not_answering", () => {
    const h = fake();
    h.state.allowed = [{ node: "", name: "lone", fp: FP_B, id: "", addrs: [] }];
    const row = yourPcs(devicesBlocks(h, newDevicesState())).find((r) => r.title === "lone");
    expect(row?.desc).toBe(`Allowed · not answering (off, or Harbor isn't sharing there) · key ${"bbbb bbbb bbbb bbbb"}`);
  });

  test("a_pc_that_refuses_us_waits", () => {
    const h = fake();
    h.state.allowed = [{ node: "", name: "lone", fp: FP_B, id: "", addrs: [] }];
    h.state.seen = new Map([[FP_B, { node: "", fp: FP_B, name: "lone", asked: 0, refuses: true }]]);
    const row = yourPcs(devicesBlocks(h, newDevicesState())).find((r) => r.title === "lone");
    expect(row?.badges[0]).toEqual({ text: "Waiting", tone: "amber" });
    expect(row?.desc.startsWith("Allowed here, but lone doesn't allow desk (pair them again)")).toBe(true);
  });

  test("a_pc_met_that_asks_is_not_paired", () => {
    const h = fake();
    h.state.seen = new Map([[FP_B, { node: "", fp: FP_B, name: "ask", asked: 3, refuses: false }]]);
    const row = yourPcs(devicesBlocks(h, newDevicesState())).find((r) => r.title === "ask");
    expect(row?.badges[0]).toEqual({ text: "Not paired", tone: "gray" });
    expect(row?.desc.startsWith("Asks to share chats with this PC: pair it with a code to allow it")).toBe(true);
  });

  test("a_tailscale_node_is_allowed_with_one_click", () => {
    const h = fake();
    h.state.seen = new Map([["nLAP", { node: "nLAP", fp: "", name: "tail", asked: 0, refuses: false }]]);
    const row = yourPcs(devicesBlocks(h, newDevicesState())).find((r) => r.title === "tail");
    expect(keysOf(row)).toEqual(["allow:nLAP"]);
    expect(row?.desc).toContain("on Tailscale, switches to its own key once both PCs have Harbor 0.13");
    devicesTab(h).pressed("allow:nLAP");
    expect(h.calls).toEqual(["allow nLAP tail true"]);
  });

  test("a_harbor_heard_on_the_network_is_paired_with_a_code", () => {
    const h = fake();
    h.state.lan = [{ fp: FP_B, name: "nearby", addr: "198.51.100.9:47930", version: "0.49.0" }];
    const row = yourPcs(devicesBlocks(h, newDevicesState())).find((r) => r.title === "nearby");
    expect(row?.desc).toBe(`On this network at 198.51.100.9:47930 · Harbor 0.49.0 · pair it with a code · key ${"bbbb bbbb bbbb bbbb"}`);
    expect(keysOf(row)).toEqual([`pairlan:${FP_B}`]);
    const t = devicesTab(h);
    t.pressed(`pairlan:${FP_B}`);
    const pair = t.blocks().find((x) => x.kind === "form");
    expect(pair?.fields[0]?.text).toBe("198.51.100.9:47930");
    expect(t.blocks().find((x) => x.text.startsWith("Now show a code on nearby"))?.text).toBe("Now show a code on nearby (Settings › Devices › Show a code) and type it below.");
  });

  test("a_peer_behind_gets_update_and_auto_update", () => {
    const h = fake();
    h.state.peers = [peer({ id: "pc:lap", name: "laptop", version: "0.40.0", update: { managed: true, auto: false, status: "up to date" } }), peer({ id: "pc:old", name: "oldie", fp: "c".repeat(64), version: "0.30.0", update: { managed: true, auto: false } })];
    const rows = yourPcs(devicesBlocks(h, newDevicesState()));
    const lap = rows.find((r) => r.title === "laptop");
    expect(lap?.desc).toContain("Harbor 0.40.0 · up to date · 0.50.0 is out");
    expect(keysOf(lap)).toEqual(["autoupdate:pc:lap", "update:pc:lap", "share:pc:lap"]);
    expect(keysOf(rows[1])).toEqual(["auto_all", "update_all", "copy_key"]);
    const t = devicesTab(h);
    t.pressed("update:pc:lap");
    expect(h.calls).toEqual(["update pc:lap"]);
    const after = yourPcs(t.blocks()).find((r) => r.title === "laptop");
    expect(after?.buttons.find((x) => x.key === "update:pc:lap")).toMatchObject({ label: "Updating…", enabled: false });
    expect(after?.desc).toContain("· updating…");
    t.pressed("update_all");
    expect(h.calls.at(-1)).toBe("update pc:old");
    t.pressed("autoupdate:pc:old");
    t.pressed("auto_all");
    expect(h.kv.get("auto_update")).toBe("1");
    expect(h.calls.slice(-2)).toEqual(["auto pc:old", "auto pc:lap,pc:old"]);
  });

  test("an_update_that_never_lands_is_forgotten_after_three_minutes", () => {
    const h = fake();
    h.state.peers = [peer({ id: "pc:lap", name: "laptop", version: "0.40.0", update: { managed: true, auto: true } })];
    const st = newDevicesState();
    st.updating.set("pc:lap", ["0.40.0", NOW - 10]);
    expect(yourPcs(devicesBlocks(h, st)).find((r) => r.title === "laptop")?.desc).toContain("updating…");
    const t = devicesTab({ ...h, now: () => NOW + 400 });
    t.pressed("update:pc:nobody");
    expect(t.blocks().length).toBeGreaterThan(0);
  });

  test("phone_access_off_on_a_peer_can_be_asked_to_turn_on", () => {
    const h = fake();
    h.state.peers = [peer({ id: "pc:lap", name: "laptop", phones: false })];
    const row = yourPcs(devicesBlocks(h, newDevicesState())).find((r) => r.title === "laptop");
    expect(row?.desc).toContain("phone access off: your phone can't use it when this PC is off");
    devicesTab(h).pressed("phones:pc:lap");
    expect(h.calls).toEqual(["enable pc:lap"]);
  });

  test("the_share_menu_opens_under_the_peer_and_picks_a_level", () => {
    const h = fake();
    h.state.peers = [peer({ id: "pc:lap", name: "laptop" })];
    const t = devicesTab(h);
    t.pressed("share:pc:lap");
    const rows = yourPcs(t.blocks());
    const i = rows.findIndex((r) => r.title === "Its chats may");
    expect(i).toBeGreaterThan(0);
    expect(rows[i]?.buttons.map((x) => [x.label, x.on])).toEqual([
      ["Nothing", false],
      ["Read my projects", false],
      ["Edit my projects", false],
      ["Everything (shell, any file, GitHub)", true],
    ]);
    t.pressed("level:pc:lap:read");
    expect(h.calls).toEqual(["level pc:lap read"]);
    expect(yourPcs(t.blocks()).some((r) => r.title === "Its chats may")).toBe(false);
    t.pressed("share:pc:lap");
    t.pressed("share:pc:lap");
    expect(yourPcs(t.blocks()).some((r) => r.title === "Its chats may")).toBe(false);
  });

  test("the_toggle_turns_sharing_on_and_off", () => {
    const h = fake();
    const t = devicesTab(h);
    t.toggled("mesh_on", false);
    expect(h.calls).toEqual(["mesh false"]);
  });
});

describe("meshctx.rs mesh_pair_ui", () => {
  test("no_code_offers_show_a_code", () => {
    const b = devicesBlocks(fake(), newDevicesState());
    const i = b.findIndex((x) => x.title === "Pair a PC");
    expect(b[i + 1]?.rows[0]).toMatchObject({ title: "Show a code", desc: "Shows a one-time code here to type on your other PC." });
    expect(keysOf(b[i + 1]?.rows[0])).toEqual(["pair_show"]);
  });

  test("a_shown_code_counts_down_with_the_address", () => {
    const h = fake();
    h.state.code = { code: "ABCDE-FGHJK", expires: NOW + 125, tries: 0, paired: "" };
    h.state.addrs = ["198.51.100.5:47930", "[2001:db8::1]:47930"];
    const b = devicesBlocks(h, newDevicesState());
    const i = b.findIndex((x) => x.title === "Pair a PC");
    const r = b[i + 1]?.rows[0];
    expect(r?.title).toBe("Code  ABCDE-FGHJK");
    expect(r?.desc).toBe("On the other PC: Settings › Devices › Enter a code, with this PC's address 198.51.100.5:47930 · good for 2:05 more, once");
    expect(r?.badges).toEqual([{ text: "Waiting", tone: "amber" }]);
    expect(keysOf(r)).toEqual(["pair_cancel"]);
    expect(b[i + 2]?.text).toBe("This PC's other addresses: [2001:db8::1]:47930");
  });

  test("a_code_with_no_network_says_so", () => {
    const h = fake();
    h.state.code = { code: "X", expires: NOW + 60, tries: 0, paired: "" };
    h.state.addrs = [];
    const b = devicesBlocks(h, newDevicesState());
    expect(b[b.findIndex((x) => x.title === "Pair a PC") + 1]?.rows[0]?.desc).toContain("address (no network) · good for 1:00 more");
  });

  test("a_used_or_void_code_offers_a_new_one", () => {
    const run = (code: PairCode) => {
      const h = fake();
      h.state.code = code;
      const b = devicesBlocks(h, newDevicesState());
      return b[b.findIndex((x) => x.title === "Pair a PC") + 1]?.rows[0];
    };
    expect(run({ code: "X", expires: NOW - 1, tries: 0, paired: "" })).toMatchObject({ title: "The code ran out.", desc: "Show a new one to pair." });
    expect(run({ code: "X", expires: NOW + 100, tries: 5, paired: "" })?.title).toBe("Too many wrong tries: the code is void.");
    expect(keysOf(run({ code: "X", expires: NOW - 1, tries: 0, paired: "" }))).toEqual(["pair_show"]);
    const done = run({ code: "X", expires: NOW + 100, tries: 1, paired: "laptop" });
    expect(done).toMatchObject({ title: "Paired with laptop", desc: "Both PCs allow each other now: their chats show up here in a moment." });
    expect(keysOf(done)).toEqual(["pair_cancel"]);
  });

  test("the_enter_a_code_form_needs_an_address_and_ten_characters", () => {
    const b = devicesBlocks(fake(), newDevicesState());
    const f = b.find((x) => x.kind === "form" && x.key === "pair");
    expect(f).toMatchObject({ frame: "header", title: "Enter a code", desc: "The address and code another PC shows under Show a code." });
    expect(f?.fields.map((x) => [x.hint, x.min, x.width])).toEqual([
      ["Its address (e.g. 10.0.0.12)", 1, 200],
      ["Code", 10, 140],
    ]);
    expect(f?.submit).toMatchObject({ label: "Pair", enabled: true });
  });

  test("showing_a_code_turns_sharing_on_and_joining_pairs", () => {
    const h = fake();
    h.state.on = false;
    const t = devicesTab(h);
    t.pressed("pair_show");
    expect(h.calls).toEqual(["show", "mesh true"]);
    expect(t.submitted("pair", [" 198.51.100.9 ", "ABCDE-FGHJK"])).toBe("");
    expect(h.calls.slice(-2)).toEqual(["mesh true", "join 198.51.100.9 ABCDE-FGHJK"]);
    expect(t.blocks().find((x) => x.kind === "form")?.fields[0]?.text).toBe("198.51.100.9");
    t.pressed("pair_cancel");
    expect(h.calls.at(-1)).toBe("cancel");
  });

  test("the_result_of_a_pairing_shows_under_the_form", () => {
    const h = fake();
    h.pair.result = () => ({ ok: false, text: "wrong code" });
    expect(devicesBlocks(h, newDevicesState()).find((x) => x.text === "Not paired: wrong code")).toBeDefined();
    h.pair.result = () => ({ ok: true, text: "Paired with laptop: its chats show up here in a moment." });
    expect(devicesBlocks(h, newDevicesState()).find((x) => x.text.startsWith("Paired with laptop"))).toBeDefined();
    h.pair.busy = () => true;
    expect(devicesBlocks(h, newDevicesState()).find((x) => x.key === "pair")?.submit).toMatchObject({ label: "Pairing…", enabled: false });
  });
});

describe("meshctx.rs people_ui", () => {
  test("the_boxes_hint_at_the_detected_values_and_show_what_was_typed", () => {
    const h = fake();
    h.kv.set(OWNER_KEY, "Ana R");
    const b = devicesBlocks(h, newDevicesState());
    const rows = b[b.findIndex((x) => x.title === "People and memory") + 1]?.rows ?? [];
    expect(rows.map((r) => r.title)).toEqual(["Your name", "Your GitHub login", "Detect who is who", "Send my instructions and memory", "My chats on other PCs may use my GitHub here"]);
    expect(rows[0]).toMatchObject({ control: "input", text: "Ana R", hint: "Ana", key: OWNER_KEY, width: 200 });
    expect(rows[1]).toMatchObject({ control: "input", text: "", hint: "ana", key: GITHUB_KEY, width: 160 });
    expect(rows[2]?.desc.endsWith("A name you typed always stays. Not run yet.")).toBe(true);
    expect(rows[3]).toMatchObject({ control: "toggle", on: true, key: SEND_KEY });
    expect(rows[4]).toMatchObject({ control: "toggle", on: true, key: machines.GITHUB_KEY });
  });

  test("typing_and_toggling_write_kv_and_tell_the_mesh", () => {
    const h = fake();
    const t = devicesTab(h);
    t.edited(OWNER_KEY, "Ana R");
    t.edited(GITHUB_KEY, "anar");
    t.toggled(SEND_KEY, false);
    t.toggled(machines.GITHUB_KEY, false);
    expect([h.kv.get(OWNER_KEY), h.kv.get(GITHUB_KEY), h.kv.get(SEND_KEY), h.kv.get(machines.GITHUB_KEY)]).toEqual(["Ana R", "anar", "0", "0"]);
    expect(h.calls).toEqual(["changed", "changed", "changed", "changed"]);
    const rows = devicesBlocks(h, newDevicesState());
    expect(rows.flatMap((x) => x.rows).find((r) => r.key === SEND_KEY)?.on).toBe(false);
  });

  test("an_unconfirmed_detection_asks_confirm_or_edit", () => {
    const h = fake();
    h.people.check = () => ({ why: "git user.name and gh login." });
    const rows = devicesBlocks(h, newDevicesState()).flatMap((x) => x.rows);
    const r = rows.find((x) => x.title === "Detected, confirm?");
    expect(r?.desc).toBe("Ana · GitHub ana. git user.name and gh login. Agents and your other PCs see it as this PC's owner.");
    expect(keysOf(r)).toEqual(["confirm_owner", "edit_owner"]);
    const t = devicesTab(h);
    t.pressed("confirm_owner");
    t.pressed("edit_owner");
    t.pressed("detect");
    expect(h.calls).toEqual(["confirm", "changed", "detect"]);
    expect([h.kv.get(OWNER_KEY), h.kv.get(GITHUB_KEY)]).toEqual(["Ana", "ana"]);
  });

  test("the_pcs_of_the_mesh_are_listed_from_two", () => {
    const h = fake();
    h.people.pcs = () => [
      { id: "pc:desk", name: "desk", me: true, online: true, owner: "Ana", github: "", phones: [], accounts: [], suggested: false, guessed: false, why: "", harbor: "", phone_apps: new Map() },
      { id: "pc:lap", name: "laptop", me: false, online: false, owner: "Leo", github: "", phones: ["A13"], accounts: [], suggested: true, guessed: false, why: "key comment", harbor: "", phone_apps: new Map() },
    ];
    const rows = devicesBlocks(h, newDevicesState()).flatMap((x) => x.rows);
    expect(rows.find((r) => r.title === "desk (this PC)" && r.desc === "Ana")).toBeDefined();
    expect(rows.find((r) => r.title === "laptop")?.desc).toBe("Leo (detected, not confirmed) · phones: A13 · offline\nkey comment");
  });
});

describe("remoteui.rs devices_tab", () => {
  const ssh = (p: Partial<RemoteHost> = {}) => newHost({ id: "ssh:1", name: "box", host: "box.example", bridge: true, ...p });

  test("ssh_defaults_read_and_write_the_config", () => {
    const h = fake();
    h.state.cfg = { tailscale: true, user: "ana", key: "~/k", port: 2200, devices: [] };
    const b = devicesBlocks(h, newDevicesState());
    const rows = b[b.findIndex((x) => x.title === "SSH") + 1]?.rows ?? [];
    expect(rows.map((r) => [r.title, r.text, r.hint, r.width])).toEqual([
      ["User", "ana", "ana", 180],
      ["Key", "~/k", "~/.ssh/id_ed25519", 220],
      ["Port", "2200", "22", 80],
    ]);
    const t = devicesTab(h);
    t.edited("ssh:user", "bob");
    t.edited("ssh:key", "~/j");
    t.edited("ssh:port", " 22 ");
    expect(h.state.cfg).toMatchObject({ user: "bob", key: "~/j", port: 22 });
    t.edited("ssh:port", "abc");
    expect(h.state.cfg.port).toBe(0);
    t.edited("ssh:port", "70000");
    expect(h.state.cfg.port).toBe(0);
  });

  test("no_devices_says_so", () => {
    const b = devicesBlocks(fake(), newDevicesState());
    expect(b.find((x) => x.kind === "list")?.empty).toBe("None yet. PCs you pair with this one appear here by themselves; add any other one by SSH below.");
  });

  test("a_device_row_has_badges_where_it_is_and_buttons", () => {
    const h = fake();
    h.state.devices = [
      [ssh({ user: "ana", os: "linux" }), null],
      [newHost({ id: "pc:lap", host: "lap.example", hidden: true, os: "macOS" }), false],
      [newHost({ id: "ts:desk", host: "desk.ts", name: "desk" }), true],
    ];
    const list = devicesBlocks(h, newDevicesState()).find((x) => x.kind === "list");
    expect(list?.rows.map((r) => [r.title, r.badges.map((x) => x.text), r.line, r.buttons.map((x) => x.label)])).toEqual([
      ["box", ["SSH"], "ana@box.example · Linux", ["Test", "Edit", "Remove"]],
      ["lap", ["Your PC", "Offline", "Hidden"], "lap.example · macOS", ["Test", "Edit", "Show"]],
      ["desk", ["Your PC", "Online"], "desk.ts", ["Test", "Edit", "Hide"]],
    ]);
  });

  test("hide_removes_and_edit_open_the_editor", () => {
    const h = fake();
    h.state.devices = [[ssh(), null], [newHost({ id: "pc:lap", host: "lap.example" }), true]];
    h.state.cfg.devices = [ssh()];
    const t = devicesTab(h);
    t.pressed("hide:pc:lap");
    expect(h.state.cfg.devices.map((d) => [d.id, d.hidden])).toEqual([["ssh:1", false], ["pc:lap", true]]);
    t.pressed("drop:ssh:1");
    expect(h.state.cfg.devices.map((d) => d.id)).toEqual(["pc:lap"]);
    expect(h.calls).toContain("icon ssh:1");
    t.pressed("edit:ssh:1");
    expect(t.blocks().find((x) => x.kind === "list")?.rows[0]?.buttons[1]?.label).toBe("Done");
    t.pressed("edit:ssh:1");
    expect(t.blocks().find((x) => x.kind === "list")?.rows[0]?.buttons[1]?.label).toBe("Edit");
  });

  test("the_editor_has_the_rust_lines", () => {
    const h = fake();
    h.state.devices = [[ssh({ user: "ana", port: 2200, dir: "~/w", commands: true, icon: "laptop" }), null]];
    h.state.cfg.devices = [ssh({ user: "ana", port: 2200, dir: "~/w", commands: true, icon: "laptop" })];
    const t = devicesTab(h);
    t.pressed("edit:ssh:1");
    const e = t.blocks().find((x) => x.kind === "list")?.rows[0]?.edit ?? [];
    expect(e.map((x) => [x.kind, x.label])).toEqual([["field", "Name"], ["field", "Address"], ["field", "User · port"], ["field", "Folder"], ["icons", "Icon"], ["toggles", ""], ["toggles", ""], ["warn", ""], ["buttons", ""]]);
    expect(e[2]?.fields.map((f) => [f.key, f.text, f.hint])).toEqual([["d:ssh:1:user", "ana", "default"], ["d:ssh:1:port", "2200", "port"]]);
    expect(e[4]?.buttons.map((b) => [b.label, b.on])[0]).toEqual(["Auto", false]);
    expect(e[4]?.buttons.filter((b) => b.on).map((b) => b.tip)).toEqual(["laptop"]);
    expect(e[5]?.toggles.map((x) => [x.label, x.on])).toEqual([["In the composer", true], ["MCP bridge", true], ["Commands on this PC", true]]);
    expect(e[6]?.toggles.map((x) => [x.label, x.on])).toEqual([["Work on this PC's files (shell, git and files run here)", true]]);
    expect(e[7]?.text).toBe("The agent on box can run any command and change any file on this PC, as you.");
    expect(e[8]?.buttons.map((b) => b.label)).toEqual(["Terminal there", "Sign in to Claude there"]);
  });

  test("the_warning_goes_when_neither_commands_nor_files_run_here", () => {
    const h = fake();
    const d = ssh({ device_files: true });
    h.state.devices = [[d, null]];
    h.state.cfg.devices = [d];
    const t = devicesTab(h);
    t.pressed("edit:ssh:1");
    expect(t.blocks().find((x) => x.kind === "list")?.rows[0]?.edit.some((x) => x.kind === "warn")).toBe(false);
  });

  test("typing_in_the_editor_updates_the_device", () => {
    const h = fake();
    const d = ssh();
    h.state.devices = [[d, null]];
    h.state.cfg.devices = [d];
    const t = devicesTab(h);
    t.edited("d:ssh:1:name", "new name");
    t.edited("d:ssh:1:host", "other.example");
    t.edited("d:ssh:1:user", "sam");
    t.edited("d:ssh:1:port", "2222");
    t.edited("d:ssh:1:dir", "~/src");
    expect(h.state.cfg.devices[0]).toMatchObject({ name: "new name", host: "other.example", user: "sam", port: 2222, dir: "~/src" });
    t.toggled("dt:ssh:1:bridge", false);
    t.toggled("dt:ssh:1:commands", true);
    t.toggled("dt:ssh:1:shown", false);
    t.toggled("dt:ssh:1:here", true);
    expect(h.state.cfg.devices[0]).toMatchObject({ bridge: false, commands: true, hidden: true, device_files: false });
    t.toggled("dt:ssh:1:here", false);
    expect(h.state.cfg.devices[0]?.device_files).toBe(true);
    t.pressed("devicon:ssh:1:globe");
    expect(h.state.cfg.devices[0]?.icon).toBe("globe");
    t.pressed("devicon:ssh:1:");
    expect(h.state.cfg.devices[0]?.icon).toBe("");
    t.pressed("devicon:ssh:1:file");
    expect(h.calls).toContain("image ssh:1");
  });

  test("a_found_pc_is_saved_when_first_edited", () => {
    const h = fake();
    h.state.devices = [[newHost({ id: "pc:lap", host: "lap.example" }), true]];
    devicesTab(h).edited("d:pc:lap:name", "Laptop");
    expect(h.state.cfg.devices).toHaveLength(1);
    expect(h.state.cfg.devices[0]).toMatchObject({ id: "pc:lap", name: "Laptop", host: "lap.example" });
  });

  test("test_and_terminals_reach_the_host", () => {
    const h = fake();
    h.state.devices = [[ssh(), null]];
    const t = devicesTab(h);
    t.pressed("test:ssh:1");
    t.pressed("terminal:ssh:1");
    t.pressed("claude:ssh:1");
    expect(h.calls).toEqual(["test ssh:1", "terminal ssh:1 ", "terminal ssh:1 claude /login"]);
  });

  test("add_by_ssh_needs_a_host_and_opens_the_new_device", () => {
    const h = fake();
    const t = devicesTab(h);
    expect(t.submitted("ssh_add", ["Box", "  ", "ana"])).toBe("");
    expect(h.calls).toEqual([]);
    t.submitted("ssh_add", [" Box ", " box.example ", " ana "]);
    expect(h.calls).toEqual(["add Box|box.example|ana|0"]);
    const f = t.blocks().find((x) => x.key === "ssh_add");
    expect(f?.fields.map((x) => [x.hint, x.width, x.min])).toEqual([["Name", 140, 0], ["host, IP or ssh alias", 200, 1], ["user (optional)", 130, 0]]);
    expect(f?.submit).toMatchObject({ label: "Add" });
  });

  test("nearby_pcs_are_one_click_chips", () => {
    const h = fake();
    h.ssh.offers = () => [
      { name: "nas", host: "nas.local", user: "", port: 0, source: "network", aka: [] },
      { name: "alias", host: "alias", user: "ana", port: 2200, source: "ssh config", aka: [] },
    ];
    const t = devicesTab(h);
    const f = t.blocks().find((x) => x.key === "ssh_add");
    expect(f?.chips_title).toBe("On your network and in ~/.ssh/config");
    expect(f?.chips.map((c) => [c.label, c.tip])).toEqual([["nas", "Add nas.local (network) and test it"], ["alias", "Add alias (ssh config) and test it"]]);
    t.pressed("offer:nas.local");
    t.pressed("offer:alias");
    expect(h.calls).toEqual(["add nas|nas.local||0", "add |alias|ana|2200"]);
  });

  test("the_notes_close_the_page", () => {
    const b = devicesBlocks(fake(), newDevicesState());
    expect(b.at(-2)?.text.startsWith("A chat picks its device in the composer and stays on it.")).toBe(true);
    expect(b.at(-1)?.text.startsWith("The MCP bridge runs this PC's MCP servers")).toBe(true);
  });
});
