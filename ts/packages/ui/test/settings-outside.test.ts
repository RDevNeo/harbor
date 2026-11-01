import { describe, expect, test } from "bun:test";
import { MemKv } from "@harbor/net";
import { outsideBlocks, outsideEdited, outsidePressed, outsideToggled, type OutsideHost } from "../src/logic/settings-outside.ts";

function host(kv = new MemKv(), summary: [string, string, boolean][] = [], blocks = false): OutsideHost & { fixed: number } {
  const h = { kv, port: () => 47930, summary: () => summary, firewallBlocksInternet: () => blocks, openInternetFix: () => void (h.fixed += 1), fixed: 0 };
  return h;
}

describe("phonesui.rs outside_section", () => {
  test("the_card_has_the_router_the_forward_and_the_name", () => {
    const b = outsideBlocks(host());
    expect(b.map((x) => x.kind)).toEqual(["title", "rows"]);
    expect(b[0]?.title).toBe("From outside your network");
    const rows = b[1]?.rows ?? [];
    expect(rows.map((r) => [r.title, r.control, r.key])).toEqual([
      ["Open a port on my router", "toggle", "net_map"],
      ["Port forward on my router", "input", "net_forward"],
      ["Public name", "input", "net_name"],
    ]);
    expect(rows[0]?.on).toBe(true);
    expect(rows[1]?.desc).toContain("this PC's port 47930");
    expect(rows[1]?.hint).toBe("e.g. 47930");
    expect(rows[2]?.hint).toBe("home.example.org");
  });

  test("the_router_toggle_reads_on_unless_zero", () => {
    expect(outsideBlocks(host(new MemKv({ net_map: "0" })))[1]?.rows[0]?.on).toBe(false);
    expect(outsideBlocks(host(new MemKv({ net_map: "1" })))[1]?.rows[0]?.on).toBe(true);
  });

  test("the_summary_lines_come_with_a_yes_or_no", () => {
    const rows = outsideBlocks(host(new MemKv(), [["IPv4: open", "by UPnP", true], ["IPv6: none", "no address", false]]))[1]?.rows ?? [];
    expect(rows.slice(3).map((r) => [r.title, r.desc, r.badges.map((x) => [x.text, x.tone])])).toEqual([
      ["IPv4: open", "by UPnP", [["Yes", "green"]]],
      ["IPv6: none", "no address", [["No", "gray"]]],
    ]);
  });

  test("a_blocking_firewall_gets_a_button", () => {
    const h = host(new MemKv(), [], true);
    const last = outsideBlocks(h)[1]?.rows.at(-1);
    expect(last?.title).toBe("The firewall blocks the internet");
    expect(outsidePressed(h, "fix_internet")).toBe(true);
    expect(h.fixed).toBe(1);
    expect(outsidePressed(h, "other")).toBe(false);
  });

  test("the_toggle_writes_net_map", () => {
    const kv = new MemKv();
    expect(outsideToggled(host(kv), "net_map", false)).toBe(true);
    expect(kv.get("net_map")).toBe("0");
    outsideToggled(host(kv), "net_map", true);
    expect(kv.get("net_map")).toBe("1");
    expect(outsideToggled(host(kv), "x", true)).toBe(false);
  });

  test("a_bad_port_or_name_is_not_saved", () => {
    const kv = new MemKv();
    const h = host(kv);
    outsideEdited(h, "net_forward", " 47930 ");
    expect(kv.get("net_forward")).toBe("47930");
    outsideEdited(h, "net_forward", "70000");
    outsideEdited(h, "net_forward", "0");
    outsideEdited(h, "net_forward", "12ab");
    expect(kv.get("net_forward")).toBe("47930");
    outsideEdited(h, "net_forward", "");
    expect(kv.get("net_forward")).toBe("");
    outsideEdited(h, "net_name", "home.example.org");
    expect(kv.get("net_name")).toBe("home.example.org");
    outsideEdited(h, "net_name", "no-dot");
    outsideEdited(h, "net_name", "bad name.org");
    expect(kv.get("net_name")).toBe("home.example.org");
    outsideEdited(h, "net_name", "");
    expect(kv.get("net_name")).toBe("");
    expect(outsideEdited(h, "x", "y")).toBe(false);
  });
});
