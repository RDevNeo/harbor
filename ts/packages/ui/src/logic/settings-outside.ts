import { portmapValidName, type Kv } from "@harbor/net";
import { badge, btn, rows, row, title, type Block } from "./settings-blocks.ts";

/** What the "From outside your network" section reads and does (Devices and Phones both show it). */
export interface OutsideHost {
  kv: Kv;
  port(): number;
  /** portmap.rs `summary`: title, detail, good. */
  summary(port: number): [string, string, boolean][];
  firewallBlocksInternet(port: number): boolean;
  /** Opens a terminal that lets the internet through ufw to Harbor's port. */
  openInternetFix(): void;
}

/** phonesui.rs `outside_section`. */
export function outsideBlocks(host: OutsideHost): Block[] {
  const port = host.port();
  const lines = [
    row("Open a port on my router", {
      desc: "Asks your router (UPnP, NAT-PMP or PCP) to let your phone on mobile data and your PCs elsewhere reach this PC. From the internet, Harbor answers only phones and PCs paired with it.",
      key: "net_map",
      control: "toggle",
      on: host.kv.get("net_map") !== "0",
    }),
    row("Port forward on my router", {
      desc: `If you forwarded a port on your router to this PC's port ${port} by hand, its number outside. Harbor then tells your phone this network's public address with it.`,
      key: "net_forward",
      control: "input",
      text: host.kv.get("net_forward") ?? "",
      hint: "e.g. 47930",
      mono: true,
      width: 90,
    }),
    row("Public name", {
      desc: "A dynamic DNS name that follows your home's public address (your router's DDNS, for example). Phones keep it, so they find this PC after the address changes.",
      key: "net_name",
      control: "input",
      text: host.kv.get("net_name") ?? "",
      hint: "home.example.org",
      mono: true,
      width: 200,
    }),
  ];
  for (const [t, detail, good] of host.summary(port)) lines.push(row(t, { desc: detail, badges: [good ? badge("Yes", "green") : badge("No")] }));
  if (host.firewallBlocksInternet(port)) {
    lines.push(row("The firewall blocks the internet", { desc: `This PC's firewall (ufw) drops port ${port} from outside your network, even where the router lets it in.`, buttons: [btn("fix_internet", "Allow from the internet")] }));
  }
  return [title("From outside your network"), rows(lines)];
}

/** A button of the section; false when it isn't one of its. */
export function outsidePressed(host: OutsideHost, key: string): boolean {
  if (key !== "fix_internet") return false;
  host.openInternetFix();
  return true;
}

export function outsideToggled(host: OutsideHost, key: string, on: boolean): boolean {
  if (key !== "net_map") return false;
  host.kv.set("net_map", on ? "1" : "0");
  return true;
}

/** Typing in the section's boxes: a bad number or name is left unsaved, as in the Rust app. */
export function outsideEdited(host: OutsideHost, key: string, text: string): boolean {
  const t = text.trim();
  if (key === "net_forward") {
    const n = Number(t);
    if (t === "" || (/^\d+$/.test(t) && n > 0 && n <= 65535)) host.kv.set("net_forward", t);
  } else if (key === "net_name") {
    if (t === "" || portmapValidName(t)) host.kv.set("net_name", t);
  } else return false;
  return true;
}
