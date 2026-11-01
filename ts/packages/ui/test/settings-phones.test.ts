import { describe, expect, test } from "bun:test";
import { MemKv, type PairedPhone, type Token } from "@harbor/net";
import { APK_URL, phonesBlocks, phonesTab, type PhonesHost } from "../src/logic/settings-phones.ts";
import type { Block } from "../src/logic/settings-blocks.ts";

const NOW = 100_000;
const FP = "a".repeat(64);

const token = (p: Partial<Token>): Token => ({ token: "t", name: "", created: 0, group: "g", fp: FP, account: "u1", account_name: "", ...p });
const phone = (p: Partial<PairedPhone>): PairedPhone => ({ group: "g", name: "", seen: 0, ip: "", via: "", app: 0, owner: "", platform: "", alive: 0, ...p });

interface Spy extends PhonesHost {
  calls: string[];
}

function host(p: Partial<PhonesHost> = {}): Spy {
  const kv = new MemKv();
  const calls: string[] = [];
  const h: Spy = {
    kv,
    now: () => NOW,
    enabled: () => false,
    setEnabled: (on) => void calls.push(`enabled ${on}`),
    net: () => ({ addrs: [], bound: [], error: "" }),
    port: () => 47930,
    firewallBlocks: () => false,
    openFirewall: () => void calls.push("firewall"),
    outside: { kv, port: () => 47930, summary: () => [], firewallBlocksInternet: () => false, openInternetFix: () => {} },
    workspace: () => "",
    workspaceName: () => null,
    owner: () => false,
    accountId: () => "u1",
    tokens: () => [],
    phones: () => [],
    signOut: (fp) => void calls.push(`signout ${fp}`),
    removeOldTokens: () => void calls.push("remove old"),
    refused: () => [],
    apk: () => null,
    qr: () => ({ width: 2, height: 2, data: new Uint8Array(16) }),
    copy: (t) => void calls.push(`copy ${t}`),
    downloadApk: () => void calls.push("download"),
    downloadBusy: () => false,
    downloadResult: () => null,
    openAccount: () => void calls.push("account"),
    calls,
    ...p,
  };
  return h;
}

const kinds = (b: Block[]) => b.map((x) => x.kind);
const titles = (b: Block[]) => b.filter((x) => x.kind === "title").map((x) => x.title);

describe("phonesui.rs phones_tab", () => {
  test("off_shows_the_toggle_then_add_phones_and_install", () => {
    const b = phonesBlocks(host());
    expect(titles(b)).toEqual(["Add a phone", "Phones", "Install the app"]);
    expect(b[0]?.rows[0]).toMatchObject({ title: "Phone access", control: "toggle", on: false, key: "phones_on" });
    expect(b[0]?.rows[0]?.desc.startsWith("Harbor for Android lists, opens and starts")).toBe(true);
    expect(b.some((x) => x.kind === "qr")).toBe(false);
  });

  test("no_workspace_asks_to_sign_in_first_with_a_button", () => {
    const b = phonesBlocks(host());
    expect(b[2]?.text).toBe("Sign in on this PC first (Settings › Account): phones reach the PCs of their account's workspaces.");
    expect(b[3]?.buttons.map((x) => [x.key, x.label])).toEqual([["open_account", "Open Settings › Account"]]);
  });

  test("a_workspace_names_itself_and_has_no_button", () => {
    const b = phonesBlocks(host({ workspace: () => "w1", workspaceName: () => "Home" }));
    expect(b[2]?.text).toContain("“Home”");
    expect(b[2]?.text).toContain("invite them in Settings › Account.");
    expect(b.some((x) => x.key === "" && x.buttons.some((y) => y.key === "open_account"))).toBe(false);
  });

  test("a_workspace_not_in_the_directory_yet_gets_the_short_text", () => {
    const b = phonesBlocks(host({ workspace: () => "w1" }));
    expect(b[2]?.text).toBe("Install Harbor for Android (below) and sign in with Google there, with an account in this PC's workspace.");
  });

  test("on_without_a_network_says_so", () => {
    const b = phonesBlocks(host({ enabled: () => true }));
    expect(b[1]).toMatchObject({ kind: "status", badge: { text: "No network", tone: "amber" }, text: "This PC has no network address right now (it's checked again every 20 s)." });
    expect(titles(b)[0]).toBe("From outside your network");
  });

  test("on_and_bound_listens_on_up_to_six_addresses", () => {
    const addrs = ["a", "b", "c", "d", "e", "f", "g"].map((x) => `198.51.100.${x.charCodeAt(0) - 96}`);
    const b = phonesBlocks(host({ enabled: () => true, net: () => ({ addrs, bound: [addrs[0] ?? ""], error: "" }) }));
    expect(b[1]).toMatchObject({ badge: { text: "Listening", tone: "green" }, title: "mono" });
    expect(b[1]?.text).toBe(`${addrs.slice(0, 6).join("  ")} · port 47930`);
  });

  test("on_but_not_bound_is_starting_and_an_error_follows", () => {
    const b = phonesBlocks(host({ enabled: () => true, net: () => ({ addrs: ["198.51.100.1"], bound: [], error: "address in use" }) }));
    expect(b[1]).toMatchObject({ badge: { text: "Starting", tone: "gray" }, text: "port 47930" });
    expect(b[2]?.text).toBe("Couldn't listen on address in use");
  });

  test("a_blocking_firewall_gets_a_button", () => {
    const h = host({ enabled: () => true, net: () => ({ addrs: ["198.51.100.1"], bound: ["x"], error: "" }), firewallBlocks: () => true });
    const b = phonesBlocks(h);
    const fw = b.find((x) => x.badge.text === "Firewall");
    expect(fw?.text).toBe("This PC's firewall (ufw) drops port 47930: phones on your network can't reach it.");
    phonesTab(h).pressed("fix_firewall");
    expect(h.calls).toEqual(["firewall"]);
  });

  test("phones_show_who_and_when", () => {
    const h = host({
      tokens: () => [token({ name: "Pixel", account_name: "Ana", group: "g1" }), token({ group: "g2", fp: "b".repeat(64) }), token({ group: "g3", fp: "c".repeat(64), name: "Old one" }), token({ group: "g4", fp: "d".repeat(64), name: "Never" })],
      phones: () => [
        phone({ group: "g1", seen: NOW - 10, alive: NOW - 10, app: 18_001_000 }),
        phone({ group: "g2", seen: NOW - 600, alive: NOW - 60, via: "laptop", app: 0 }),
        phone({ group: "g3", seen: NOW - 7200, alive: 0, app: 17_000 }),
      ],
      apk: () => ({ code: 18_002_000 }),
    });
    const list = phonesBlocks(h).find((x) => x.kind === "list");
    expect(list?.rows.map((r) => [r.title, r.line])).toEqual([
      ["Pixel", `Signed in as Ana · key aaaa aaaa aaaa aaaa · Harbor open · app 18.1.0 → 18.2.0 available`],
      ["Phone", `Signed in · key bbbb bbbb bbbb bbbb · online via laptop, app in the background (checked in 1m ago) · app older than 0.17: update it`],
      ["Old one", `Signed in · key cccc cccc cccc cccc · last seen 2h ago · app 0.17+, 18.2.0 available`],
      ["Never", `Signed in · key dddd dddd dddd dddd`],
    ]);
  });

  test("a_phone_that_called_just_now_reads_just_now", () => {
    const h = host({ tokens: () => [token({ group: "g1" })], phones: () => [phone({ group: "g1", seen: NOW - 100, alive: 0, app: 18_000_000 })] });
    expect(phonesBlocks(h).find((x) => x.kind === "list")?.rows[0]?.line).toBe(`Signed in · key aaaa aaaa aaaa aaaa · last seen 1m ago · app 18.0.0`);
    const h2 = host({ tokens: () => [token({ group: "g1" })], phones: () => [phone({ group: "g1", seen: NOW - 80, alive: NOW - 80, app: 18_000_000 })] });
    expect(phonesBlocks(h2).find((x) => x.kind === "list")?.rows[0]?.line).toContain("online, app in the background (checked in 1m ago)");
  });

  test("the_account_or_an_owner_may_sign_a_phone_out", () => {
    const own = host({ tokens: () => [token({ account: "u1" }), token({ account: "u2", fp: "b".repeat(64) })] });
    expect(phonesBlocks(own).find((x) => x.kind === "list")?.rows.map((r) => r.buttons.map((b) => b.key))).toEqual([[`signout:${FP}`], []]);
    const owner = host({ owner: () => true, tokens: () => [token({ account: "u2" })] });
    expect(phonesBlocks(owner).find((x) => x.kind === "list")?.rows[0]?.buttons[0]?.tip).toContain("For a lost phone.");
    phonesTab(owner).pressed(`signout:${FP}`);
    expect(owner.calls).toEqual([`signout ${FP}`]);
  });

  test("an_empty_list_says_no_phone_has_connected", () => {
    expect(phonesBlocks(host()).find((x) => x.kind === "list")?.empty).toBe("No phone has connected yet.");
  });

  test("pairings_from_before_google_accounts_can_be_removed", () => {
    const h = host({ tokens: () => [token({ account: "" }), token({ account: "", fp: "b".repeat(64) }), token({})] });
    const b = phonesBlocks(h);
    const old = b.find((x) => x.text.includes("from before Google accounts"));
    expect(old?.text).toBe("2 phone pairings from before Google accounts: they can only update the app, then sign in.");
    expect(b.find((x) => x.kind === "list")?.rows).toHaveLength(1);
    phonesTab(h).pressed("remove_old");
    expect(h.calls).toEqual(["remove old"]);
    expect(phonesBlocks(host({ tokens: () => [token({ account: "" })] })).find((x) => x.text.includes("before Google"))?.text.startsWith("1 phone pairing from")).toBe(true);
  });

  test("recently_refused_shows_the_last_four_newest_first", () => {
    const h = host({
      refused: () => [
        [NOW - 3600, "one"],
        [NOW - 1800, "two"],
        [NOW - 600, "three"],
        [NOW - 120, "four"],
        [NOW - 10, "five"],
      ],
    });
    const b = phonesBlocks(h);
    const i = b.findIndex((x) => x.text === "Recently refused");
    expect(b.slice(i + 1, i + 5).map((x) => x.text)).toEqual(["now ago · five", "2m ago · four", "10m ago · three", "30m ago · two"]);
    expect(b[i + 1]?.title).toBe("mono");
  });

  test("install_text_depends_on_the_app_being_here", () => {
    expect(phonesBlocks(host()).find((x) => x.text.startsWith("This PC doesn't have the app yet"))?.text).toBe("This PC doesn't have the app yet. Installed copies of Harbor get it with every update; this one can download it from the latest release.");
    const b = phonesBlocks(host({ apk: () => ({ code: 18_002_000 }) }));
    expect(b.find((x) => x.text.startsWith("Harbor for Android"))?.text).toBe("Harbor for Android (build 18002000) is on this PC. To install it, scan the code with the phone's camera (it downloads the latest release); the app updates itself from this PC afterwards.");
    expect(phonesBlocks(host({ apk: () => ({ code: 0 }) })).find((x) => x.text.startsWith("Harbor for Android is on"))).toBeDefined();
  });

  test("the_code_shows_only_with_phone_access_on", () => {
    const b = phonesBlocks(host({ enabled: () => true }));
    const q = b.find((x) => x.kind === "qr");
    expect(q?.text).toBe(APK_URL);
    expect(q?.image.width).toBe(2);
    expect(q?.buttons[0]?.key).toBe("copy_url");
    expect(kinds(phonesBlocks(host())).includes("qr")).toBe(false);
  });

  test("download_says_how_it_went", () => {
    const label = (h: PhonesHost) => phonesBlocks(h).at(-1);
    expect(label(host())?.buttons[0]?.label).toBe("Download the app");
    expect(label(host({ apk: () => ({ code: 1 }) }))?.buttons[0]?.label).toBe("Download the latest app");
    expect(label(host({ downloadBusy: () => true }))?.text).toBe("Downloading…");
    expect(label(host({ downloadResult: () => ({ ok: true, code: 18_002_000 }) }))?.text).toBe("Build 18002000 is ready.");
    expect(label(host({ downloadResult: () => ({ ok: false, error: "no release" }) }))?.text).toBe("no release");
  });

  test("download_waits_while_another_runs", () => {
    const h = host();
    phonesTab(h).pressed("download");
    const busy = host({ downloadBusy: () => true });
    phonesTab(busy).pressed("download");
    expect(h.calls).toEqual(["download"]);
    expect(busy.calls).toEqual([]);
  });

  test("buttons_and_the_toggle_reach_the_host", () => {
    const h = host();
    const t = phonesTab(h);
    t.toggled("phones_on", true);
    t.pressed("open_account");
    t.pressed("copy_url");
    expect(h.calls).toEqual(["enabled true", "account", `copy ${APK_URL}`]);
    t.toggled("net_map", false);
    expect(h.kv.get("net_map")).toBe("0");
    t.edited("net_name", "home.example.org");
    expect(h.kv.get("net_name")).toBe("home.example.org");
  });
});
