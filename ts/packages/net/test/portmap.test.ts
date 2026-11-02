import { afterEach, describe, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemKv } from "../src/kv.ts";
import {
  gatewayV4,
  gatewayV6,
  igdService,
  pcpParse,
  pcpRequest,
  pmpMapParse,
  pmpPublicParse,
  pmpRequest,
  Portmap,
  portmapAgo,
  portmapBaseOf,
  portmapIsPublic,
  portmapMapTo,
  portmapTag,
  portmapValidName,
  type PortmapNet,
} from "../src/portmap.ts";

const LOOP = [127, 0, 0, 1].join(".");
const PUBLIC = "203.0.113.7";
const octets = (...o: number[]) => o.join(".");
const v4Bytes = (s: string) => s.split(".").map(Number);

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

async function freeUdpPort(): Promise<number> {
  const s = createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, LOOP, r));
  const p = s.address().port;
  await new Promise<void>((r) => s.close(r));
  return p;
}

type Mode = "ok" | "silent" | "refuse" | "unsupported";

interface Nat {
  port: number;
  requests: string[];
}

/** A router's PCP and NAT-PMP on one UDP socket, like the real thing. */
async function fakeNat(o: { host?: string; port?: number; pcp: Mode; pmp: Mode; publicIp?: string; shift?: number }): Promise<Nat> {
  const host = o.host ?? LOOP;
  const ip = v4Bytes(o.publicIp ?? PUBLIC);
  const shift = o.shift ?? 0;
  const s = createSocket(host.includes(":") ? "udp6" : "udp4");
  const requests: string[] = [];
  s.on("message", (m, r) => {
    const reply = (b: number[]) => s.send(Uint8Array.from(b), r.port, r.address);
    if (m[0] === 2 && m[1] === 1) {
      requests.push("pcp");
      if (o.pcp === "silent") return;
      if (o.pcp === "unsupported") return reply([0, 0x81, 0, 1, 0, 0, 0, 0]);
      const result = o.pcp === "refuse" ? 2 : 0;
      const ext = (((m[42] ?? 0) << 8) | (m[43] ?? 0)) + shift;
      reply([2, 0x81, 0, result, 0, 0, 14, 16, 0, 0, 0, 1, ...new Array<number>(12).fill(0), ...m.subarray(24, 36), 6, 0, 0, 0, m[40] ?? 0, m[41] ?? 0, (ext >> 8) & 255, ext & 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...ip]);
    } else if (m[0] === 0 && m[1] === 0) {
      requests.push("pmp-public");
      if (o.pmp === "silent") return;
      reply([0, 128, 0, o.pmp === "refuse" ? 3 : 0, 0, 0, 0, 1, ...ip]);
    } else if (m[0] === 0 && m[1] === 2) {
      requests.push("pmp-map");
      if (o.pmp === "silent") return;
      const ext = (((m[6] ?? 0) << 8) | (m[7] ?? 0)) + shift;
      reply([0, 130, 0, o.pmp === "refuse" ? 3 : 0, 0, 0, 0, 1, m[4] ?? 0, m[5] ?? 0, (ext >> 8) & 255, ext & 255, 0, 0, 14, 16]);
    }
  });
  await new Promise<void>((r) => s.bind(o.port ?? 0, host, r));
  cleanup.push(() => s.close());
  return { port: s.address().port, requests };
}

interface Igd {
  ssdpPort: number;
  base: string;
  calls: { method: string; url: string; action: string; body: string }[];
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let t = "";
    req.on("data", (c: Buffer) => (t += c.toString()));
    req.on("end", () => resolve(t));
  });

/** A router's UPnP: SSDP over UDP, its description and SOAP control over HTTP. */
async function fakeIgd(o: { desc: (base: string) => string; extIp?: string | null; refuseMap?: boolean }): Promise<Igd> {
  const calls: Igd["calls"] = [];
  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const action = String(req.headers.soapaction ?? "");
      calls.push({ method: req.method ?? "", url: req.url ?? "", action, body });
      if (req.method === "GET" && req.url === "/rootDesc.xml") return res.end(o.desc(base));
      if (action.endsWith("#AddPortMapping\"")) {
        res.statusCode = o.refuseMap ? 500 : 200;
        return res.end("<ok/>");
      }
      if (action.endsWith("#GetExternalIPAddress\"") && o.extIp) return res.end(`<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>${o.extIp}</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`);
      res.statusCode = 500;
      res.end("error");
    });
  });
  await new Promise<void>((r) => server.listen(0, LOOP, r));
  const base = `http://${LOOP}:${(server.address() as AddressInfo).port}`;
  const udp = createSocket("udp4");
  udp.on("message", (m, r) => {
    if (m.toString().startsWith("M-SEARCH")) udp.send(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nlocation: ${base}/rootDesc.xml\r\nST: upnp:rootdevice\r\n\r\n`, r.port, r.address);
  });
  await new Promise<void>((r) => udp.bind(0, LOOP, r));
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
    udp.close();
  });
  return { ssdpPort: udp.address().port, base, calls };
}

const wanDesc = (ctl: string, extra = "") =>
  `<root>${extra}<device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service></serviceList><deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>${ctl}</controlURL></service></serviceList></device></deviceList></device></root>`;

function loopNet(o: Partial<PortmapNet> & Pick<PortmapNet, "natPort" | "ssdp">): PortmapNet {
  return {
    gatewayV4: () => LOOP,
    gatewayV6: () => null,
    localTo: async () => LOOP,
    lanAddrs: () => [],
    waitMs: 80,
    ssdpWaitMs: 200,
    httpMs: 2000,
    publicUrls: [],
    publicMs: 1000,
    everyMs: 600_000,
    forwardEveryMs: 600_000,
    ...o,
  };
}

/** A net where nothing answers: UDP to a port nobody listens on. */
async function silentNet(extra: Partial<PortmapNet> = {}): Promise<PortmapNet> {
  return loopNet({ natPort: await freeUdpPort(), ssdp: { addr: LOOP, port: await freeUdpPort() }, ...extra });
}

const portmapOf = (net: PortmapNet, kv = new MemKv(), secs = () => 1_000_000) => new Portmap({ kv, net, nowSecs: secs });

describe("portmap", () => {
  test("gateways", () => {
    const r = "Iface\tDestination\tGateway \tFlags\nwlan0\t00000000\t0100000A\t0003\t0\t0\t600\t00000000\t0\t0\t0\nwlan0\t0000000A\t00000000\t0001\n";
    expect(gatewayV4(r)).toBe(octets(10, 0, 0, 1));
    expect(gatewayV4("Iface\n")).toBeNull();
    expect(gatewayV4("Iface\nwlan0\t00000000\t00000000\t0003\n")).toBeNull();
    const r6 = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000258 00000001 00000000 00000003 wlan0\n";
    expect(gatewayV6(r6)).toEqual({ ip: "fe80::1", dev: "wlan0" });
    expect(gatewayV6(r6.replace("wlan0", "lo"))).toBeNull();
  });

  test("nat_pmp", () => {
    expect(Array.from(pmpRequest(47930, 3600))).toEqual([0, 2, 0, 0, 0xbb, 0x3a, 0xbb, 0x3a, 0, 0, 0x0e, 0x10]);
    expect(pmpPublicParse(Uint8Array.from([0, 128, 0, 0, 0, 0, 0, 1, 203, 0, 113, 7]))).toBe(PUBLIC);
    expect(() => pmpPublicParse(Uint8Array.from([0, 128, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0]))).toThrow("refused (code 3)");
    expect(() => pmpPublicParse(Uint8Array.from([1, 2, 3]))).toThrow("not a NAT-PMP answer");
    expect(pmpMapParse(Uint8Array.from([0, 130, 0, 0, 0, 0, 0, 1, 0xbb, 0x3a, 0xbb, 0x3b, 0, 0, 0x0e, 0x10]))).toBe(47931);
  });

  test("pcp", () => {
    const nonce = new Uint8Array(12).fill(7);
    const client = octets(10, 0, 0, 5);
    const m = pcpRequest(client, 47930, 3600, nonce);
    expect(m.length).toBe(60);
    expect(Array.from(m.subarray(0, 4))).toEqual([2, 1, 0, 0]);
    expect(Array.from(m.subarray(8, 24))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 10, 0, 0, 5]);
    expect(m[36]).toBe(6);
    // An answer: opcode with the response bit, result 0, the same nonce, port and address.
    const r = Uint8Array.from([2, 0x81, 0, 0, 0, 0, 0x0e, 0x10, ...new Array<number>(16).fill(0), ...nonce, 6, 0, 0, 0, 0xbb, 0x3a, 0xbb, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 203, 0, 113, 7]);
    expect(pcpParse(r, nonce)).toEqual({ ip: PUBLIC, port: 47930 });
    expect(() => pcpParse(r, new Uint8Array(12).fill(1))).toThrow("answer to another request");
    r[3] = 8;
    expect(() => pcpParse(r, nonce)).toThrow("code 8");
  });

  test("upnp_description", () => {
    const d = wanDesc("/ctl/IPConn");
    const base = `http://${octets(10, 0, 0, 1)}:5000`;
    expect(igdService(d, base)).toEqual({ st: "urn:schemas-upnp-org:service:WANIPConnection:1", url: `${base}/ctl/IPConn` });
    expect(igdService("<root/>", "http://x")).toBeNull();
    expect(portmapBaseOf(`${base}/rootDesc.xml`)).toBe(base);
    expect(portmapTag("<a><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></a>", "NewExternalIPAddress")).toBe(PUBLIC);
    // v2 wins over v1; an absolute control URL is kept.
    const both = wanDesc("/one").replace("</root>", "<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><controlURL>http://h:1/two</controlURL></service></root>");
    expect(igdService(both, base)?.url).toBe("http://h:1/two");
  });

  test("names", () => {
    expect(portmapValidName("home.example.org") && portmapValidName("my-pc.ddns.net")).toBe(true);
    for (const bad of ["localhost", "a b.org", ".x.org", "x.org.", "x;rm.org"]) expect(portmapValidName(bad)).toBe(false);
  });

  test("public_or_not", () => {
    expect(portmapIsPublic(PUBLIC) && portmapIsPublic("2001:db8::1")).toBe(true);
    expect(portmapIsPublic(octets(10, 0, 0, 1)) || portmapIsPublic(octets(100, 70, 1, 1))).toBe(false);
    expect(portmapIsPublic("fd00::1")).toBe(false);
    expect(portmapIsPublic(LOOP) || portmapIsPublic("0.0.0.0") || portmapIsPublic(octets(224, 0, 0, 1))).toBe(false);
  });

  test("PCP maps first, and the router may pick another external port", async () => {
    const nat = await fakeNat({ pcp: "ok", pmp: "ok", shift: 1 });
    const pm = portmapOf(loopNet({ natPort: nat.port, ssdp: { addr: LOOP, port: await freeUdpPort() } }));
    const s = await pm.check(47930);
    expect(s.mapped).toEqual(["PCP", { ip: PUBLIC, port: 47931 }]);
    expect(s.tried).toEqual([["PCP", `mapped as ${PUBLIC}:47931`]]);
    expect(s.publicV4).toBe(PUBLIC);
    expect(nat.requests).toEqual(["pcp"]);
    expect(await portmapMapTo(loopNet({ natPort: nat.port, ssdp: { addr: LOOP, port: 1 } }), 47930, 8080)).toEqual(["PCP", { ip: PUBLIC, port: 8081 }]);
  });

  test("a router with NAT-PMP only: PCP is told apart, NAT-PMP maps", async () => {
    const nat = await fakeNat({ pcp: "unsupported", pmp: "ok" });
    const pm = portmapOf(loopNet({ natPort: nat.port, ssdp: { addr: LOOP, port: await freeUdpPort() } }));
    const s = await pm.check(47930);
    expect(s.tried).toEqual([["PCP", "not a PCP answer"], ["NAT-PMP", `mapped as ${PUBLIC}:47930`]]);
    expect(s.mapped).toEqual(["NAT-PMP", { ip: PUBLIC, port: 47930 }]);
    expect(s.publicV4).toBe(PUBLIC);
    expect(nat.requests).toEqual(["pcp", "pmp-public", "pmp-map"]);
  });

  test("a refusal is reported with its code, and the next method is tried", async () => {
    const nat = await fakeNat({ pcp: "refuse", pmp: "refuse" });
    const pm = portmapOf(loopNet({ natPort: nat.port, ssdp: { addr: LOOP, port: await freeUdpPort() } }));
    const s = await pm.check(47930);
    expect(s.mapped).toBeNull();
    expect(s.tried.slice(0, 2)).toEqual([["PCP", "refused (code 2)"], ["NAT-PMP", "refused (code 3)"]]);
    expect(s.tried[2]?.[0]).toBe("UPnP");
  });

  test("UPnP maps when PCP and NAT-PMP are silent", async () => {
    const igd = await fakeIgd({ desc: () => wanDesc("/ctl/IPConn"), extIp: PUBLIC });
    const net = await silentNet({ ssdp: { addr: LOOP, port: 0 } });
    net.ssdp.port = igd.ssdpPort;
    const pm = portmapOf(net);
    const s = await pm.check(47930);
    expect(s.tried).toEqual([["PCP", "no answer"], ["NAT-PMP", "no answer"], ["UPnP", `mapped as ${PUBLIC}:47930`]]);
    expect(s.mapped).toEqual(["UPnP", { ip: PUBLIC, port: 47930 }]);
    expect(s.publicV4).toBe(PUBLIC);
    const add = igd.calls.find((c) => c.action.endsWith("#AddPortMapping\""));
    expect(add?.method).toBe("POST");
    expect(add?.url).toBe("/ctl/IPConn");
    expect(add?.action).toBe('"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"');
    expect(add?.body).toContain("<NewExternalPort>47930</NewExternalPort><NewProtocol>TCP</NewProtocol><NewInternalPort>47930</NewInternalPort>");
    expect(add?.body).toContain(`<NewInternalClient>${LOOP}</NewInternalClient>`);
    expect(add?.body).toContain("<NewPortMappingDescription>Harbor</NewPortMappingDescription><NewLeaseDuration>3600</NewLeaseDuration>");
    expect(igd.calls.some((c) => c.action === '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"')).toBe(true);
  });

  test("UPnP: URLBase makes a relative control URL absolute; an unanswered address leaves the public one unknown", async () => {
    const igd = await fakeIgd({ desc: (b) => wanDesc("ctl", `<URLBase>${b}/base/</URLBase>`), extIp: null });
    const net = await silentNet();
    net.ssdp.port = igd.ssdpPort;
    const s = await portmapOf(net).check(47930);
    expect(igd.calls.some((c) => c.url === "/base/ctl")).toBe(true);
    expect(s.tried[2]).toEqual(["UPnP", "mapped as 0.0.0.0:47930"]);
  });

  test("UPnP: a refused mapping, a description without a WAN service, a router that never answers SSDP", async () => {
    const refused = await fakeIgd({ desc: () => wanDesc("/c"), refuseMap: true });
    const net = await silentNet();
    net.ssdp.port = refused.ssdpPort;
    expect((await portmapOf(net).check(47930)).tried[2]).toEqual(["UPnP", "answered 500"]);

    const empty = await fakeIgd({ desc: () => "<root/>" });
    net.ssdp.port = empty.ssdpPort;
    expect((await portmapOf(net).check(47930)).tried[2]).toEqual(["UPnP", "no WAN connection service"]);

    const quiet = await silentNet();
    expect((await portmapOf(quiet).check(47930)).tried).toEqual([["PCP", "no answer"], ["NAT-PMP", "no answer"], ["UPnP", "no answer"]]);
  });

  test("UPnP never follows the router to an address off this network", async () => {
    const outside = octets(203, 0, 113, 9);
    const igd = await fakeIgd({ desc: () => wanDesc(`http://${outside}/ctl`) });
    const net = await silentNet();
    net.ssdp.port = igd.ssdpPort;
    const s = await portmapOf(net).check(47930);
    expect(s.tried[2]).toEqual(["UPnP", "not on this network"]);
    expect(igd.calls).toHaveLength(1);
  });

  test("mapTo says why every method failed", async () => {
    const net = await silentNet();
    await expect(portmapMapTo(net, 1000, 1000)).rejects.toThrow("PCP: no answer · NAT-PMP: no answer · UPnP: no answer");
    await expect(portmapMapTo({ ...net, gatewayV4: () => null }, 1000, 1000)).rejects.toThrow("no default gateway");
    await expect(portmapMapTo({ ...net, localTo: async () => null }, 1000, 1000)).rejects.toThrow("no address towards the router");
  });

  test("no gateway: the state says so", async () => {
    const pm = portmapOf(await silentNet({ gatewayV4: () => null }));
    const s = await pm.check(47930);
    expect(s.tried).toEqual([["IPv4", "no default gateway"]]);
  });

  test("IPv6: a pinhole for each global address, stopping at the first refusal", async () => {
    const global = "2001:db8::5";
    const natOk = await fakeNat({ host: "::1", pcp: "ok", pmp: "silent" });
    const net = loopNet({ natPort: natOk.port, ssdp: { addr: LOOP, port: 1 }, gatewayV4: () => null, gatewayV6: () => ({ ip: "::1", dev: "" }), lanAddrs: () => [global, octets(192, 168, 1, 5), "fd00::9", "2001:db8::6"] });
    const s = await portmapOf(net).check(47930);
    expect(s.pinholes).toEqual([global, "2001:db8::6"]);
    expect(natOk.requests).toEqual(["pcp", "pcp"]);

    const natNo = await fakeNat({ host: "::1", pcp: "refuse", pmp: "silent" });
    const s2 = await portmapOf({ ...net, natPort: natNo.port }).check(47930);
    expect(s2.pinholes).toEqual([]);
    expect(s2.tried).toEqual([["IPv4", "no default gateway"], ["PCP (IPv6)", "refused (code 2)"]]);
    expect(natNo.requests).toEqual(["pcp"]);
  });

  test("start checks now, keeps what reached it, and stops", async () => {
    const nat = await fakeNat({ pcp: "ok", pmp: "ok" });
    const kv = new MemKv({ net_outside: JSON.stringify([999_900, octets(198, 51, 100, 4)]) });
    const pm = portmapOf(loopNet({ natPort: nat.port, ssdp: { addr: LOOP, port: 1 } }), kv);
    expect(pm.summary(47930)[0]?.[0]).toBe("IPv4: checking…");
    const stop = pm.start(47930, () => true);
    expect(pm.start(47930, () => true)).toBe(stop);
    await until(() => pm.state().checked !== null);
    const s = pm.state();
    expect(s.mapped?.[0]).toBe("PCP");
    expect(s.outside).toEqual([999_900, octets(198, 51, 100, 4)]);
    expect(pm.publicAddr()).toBe(`${PUBLIC}:47930`);
    expect(pm.summary(47930)).toEqual([
      ["IPv4: open", `PCP on your router maps ${PUBLIC}:47930 to this PC`, true],
      ["Reached from the internet", `A paired device reached this PC from ${octets(198, 51, 100, 4)}, 1m ago`, true],
    ]);
    stop();
    const before = nat.requests.length;
    await Bun.sleep(100);
    expect(nat.requests.length).toBe(before);
  });

  test("start with sharing off asks nothing and says so", async () => {
    const nat = await fakeNat({ pcp: "ok", pmp: "ok" });
    const pm = portmapOf(loopNet({ natPort: nat.port, ssdp: { addr: LOOP, port: 1 } }));
    const stop = pm.start(47930, () => false);
    cleanup.push(stop);
    await until(() => pm.state().tried.length > 0);
    expect(pm.state().tried).toEqual([["Router", "off (Settings)"]]);
    expect(pm.state().mapped).toBeNull();
    expect(nat.requests).toEqual([]);
  });

  test("a mapped address behind the provider's shared address can't be reached, and says so", async () => {
    const shared = octets(100, 70, 1, 1);
    const nat = await fakeNat({ pcp: "ok", pmp: "ok", publicIp: shared });
    const pm = portmapOf(loopNet({ natPort: nat.port, ssdp: { addr: LOOP, port: 1 } }));
    cleanup.push(pm.start(47930, () => true));
    await until(() => pm.state().checked !== null);
    expect(pm.publicAddr()).toBeNull();
    expect(pm.summary(47930)[0]).toEqual(["IPv4: behind your provider's shared address", `PCP mapped ${shared}:47930, but that address is itself behind your provider's NAT, so it can't be reached from the internet`, false]);
  });

  test("nothing opened: the summary lists what each method said", async () => {
    const pm = portmapOf(await silentNet({ lanAddrs: () => ["2001:db8::5"] }));
    cleanup.push(pm.start(47930, () => true));
    await until(() => pm.state().checked !== null);
    const [v4, v6] = pm.summary(47930);
    expect(v4).toEqual(["IPv4: not reachable from the internet", "Your router didn't open port 47930 (PCP: no answer · NAT-PMP: no answer · UPnP: no answer). A port forward to this PC on the router would do it.", false]);
    expect(v6).toEqual(["IPv6: not confirmed", "This PC has a global IPv6 address (2001:db8::5). Whether your router lets connections in is known once your phone reaches it on mobile data.", false]);
    const none = portmapOf(await silentNet());
    expect(none.summary(1)[1]).toEqual(["IPv6: none", "This PC has no global IPv6 address.", false]);
  });

  test("reached remembers a public visitor for a minute at a time", async () => {
    let t = 5000;
    const kv = new MemKv();
    const pm = portmapOf(await silentNet(), kv, () => t);
    const a = octets(198, 51, 100, 4);
    pm.reached(a);
    expect(kv.get("net_outside")).toBe(`[5000,"${a}"]`);
    t = 5060;
    pm.reached("2001:db8::9");
    expect(pm.state().outside).toEqual([5000, a]);
    t = 5061;
    pm.reached("2001:db8::9");
    expect(pm.state().outside).toEqual([5061, "2001:db8::9"]);
    expect(kv.get("net_outside")).toBe('[5061,"2001:db8::9"]');
    expect(pm.summary(1).at(-1)).toEqual(["Reached from the internet", "A paired device reached this PC from 2001:db8::9, now ago", true]);
  });

  test("portmapAgo", () => {
    expect([0, 59, 60, 3599, 3600, 86399, 86400, 200000].map((d) => portmapAgo(1000 - d, 1000))).toEqual(["now", "now", "1m", "59m", "1h", "23h", "1d", "2d"]);
    expect(portmapAgo(2000, 1000)).toBe("now");
  });

  test("public name: kv net_name with the forwarded port, else the API port", async () => {
    const kv = new MemKv({ net_name: "  Home.Example.Org " });
    const pm = portmapOf(await silentNet(), kv);
    expect(pm.publicName(47930)).toBe("home.example.org:47930");
    kv.set("net_forward", " 8443 ");
    expect(pm.publicName(47930)).toBe("home.example.org:8443");
    kv.set("net_name", "localhost");
    expect(pm.publicName(47930)).toBeNull();
  });

  describe("the port forward", () => {
    async function echo(answers: { status: number; body: string }[]): Promise<{ urls: string[]; hits: () => number }> {
      let hits = 0;
      const servers: Server[] = [];
      const urls: string[] = [];
      for (const a of answers) {
        const server = createServer((_, res) => {
          hits++;
          res.statusCode = a.status;
          res.end(a.body);
        });
        await new Promise<void>((r) => server.listen(0, LOOP, r));
        urls.push(`http://${LOOP}:${(server.address() as AddressInfo).port}/`);
        servers.push(server);
      }
      cleanup.push(() => servers.forEach((s) => s.close()));
      return { urls, hits: () => hits };
    }

    test("askPublicV4 skips failures and addresses that aren't public", async () => {
      const e = await echo([{ status: 500, body: PUBLIC }, { status: 200, body: octets(10, 0, 0, 2) }, { status: 200, body: "not an address" }, { status: 200, body: ` ${PUBLIC}\n` }]);
      const pm = portmapOf(await silentNet({ publicUrls: e.urls }));
      expect(await pm.askPublicV4()).toBe(PUBLIC);
      expect(e.hits()).toBe(4);
      expect(await portmapOf(await silentNet({ publicUrls: e.urls.slice(0, 3) })).askPublicV4()).toBeNull();
    });

    test("refreshForward follows kv net_forward and keeps the last address when the lookup fails", async () => {
      const kv = new MemKv();
      const e = await echo([{ status: 200, body: PUBLIC }]);
      const net = await silentNet({ publicUrls: e.urls });
      const pm = portmapOf(net, kv);
      await pm.refreshForward();
      expect(pm.state().forwarded).toBeNull();
      expect(e.hits()).toBe(0);
      kv.set("net_forward", "8443");
      await pm.refreshForward();
      expect(pm.state().forwarded).toEqual({ ip: PUBLIC, port: 8443 });
      expect(pm.publicAddr()).toBe(`${PUBLIC}:8443`);
      expect(pm.summary(47930)[0]).toEqual(["IPv4: open (port forward)", `Your router forwards ${PUBLIC}:8443 to this PC (set by hand on the router)`, true]);
      net.publicUrls = [`http://${LOOP}:1/`];
      await pm.refreshForward();
      expect(pm.state().forwarded).toEqual({ ip: PUBLIC, port: 8443 });
      kv.set("net_forward", "");
      await pm.refreshForward();
      expect(pm.state().forwarded).toBeNull();
    });
  });

  describe("harbor net", () => {
    function io() {
      const out: string[] = [];
      const err: string[] = [];
      return { out, err, io: { log: (l: string) => void out.push(l), err: (l: string) => void err.push(l), firewallBlocksInternet: () => false, firewallFixInternet: () => "fix" } };
    }

    test("forward and name are kept in the kv; bad input prints usage", async () => {
      const kv = new MemKv();
      const pm = portmapOf(await silentNet(), kv);
      const a = io();
      expect(await pm.cli(["forward", "8443"], a.io)).toBe(0);
      expect(kv.get("net_forward")).toBe("8443");
      expect(a.out).toEqual(["port forward: 8443 (Harbor picks it up within 5 minutes)"]);
      expect(await pm.cli(["forward", "off"], a.io)).toBe(0);
      expect(kv.get("net_forward")).toBe("");
      expect(await pm.cli(["forward", "0"], a.io)).toBe(2);
      expect(await pm.cli(["forward", "70000"], a.io)).toBe(2);
      expect(a.err).toEqual(["usage: harbor net forward <external port|off>", "usage: harbor net forward <external port|off>"]);
      expect(await pm.cli(["name", "home.example.org"], a.io)).toBe(0);
      expect(kv.get("net_name")).toBe("home.example.org");
      expect(a.out.at(-1)).toBe("public name: home.example.org");
      expect(await pm.cli(["name", "off"], a.io)).toBe(0);
      expect(kv.get("net_name")).toBe("");
      expect(await pm.cli(["name", "nodots"], a.io)).toBe(2);
      expect(a.err.at(-1)).toBe("usage: harbor net name <dns name|off>");
      expect(await pm.cli(["forward"], a.io)).toBe(2);
      expect(await pm.cli(["wat"], a.io)).toBe(2);
      expect(a.err.at(-1)).toBe("usage: harbor net [forward <port|off> | name <name|off>]");
    });

    test("without arguments it asks the router and prints what was found", async () => {
      const nat = await fakeNat({ pcp: "silent", pmp: "ok" });
      const kv = new MemKv({ api_port: "41000", net_name: "home.example.org" });
      const pm = portmapOf(loopNet({ natPort: nat.port, ssdp: { addr: LOOP, port: await freeUdpPort() } }), kv);
      const a = io();
      const fw = { ...a.io, firewallBlocksInternet: (p: number) => p === 41000 };
      expect(await pm.cli([], fw)).toBe(0);
      expect(a.out).toEqual([
        "asking the router about port 41000…",
        "  PCP         no answer",
        `  NAT-PMP     mapped as ${PUBLIC}:41000`,
        "public name: home.example.org:41000",
        `IPv4: open\n  NAT-PMP on your router maps ${PUBLIC}:41000 to this PC`,
        "IPv6: none\n  This PC has no global IPv6 address.",
        "firewall: ufw drops port 41000 from the internet; to let paired devices in:\n  fix",
      ]);
      expect(pm.state().mapped?.[0]).toBe("NAT-PMP");
    });

    test("a set forward is looked up and a failed lookup is said", async () => {
      const kv = new MemKv({ net_forward: "8443" });
      const pm = portmapOf(await silentNet({ publicUrls: [`http://${LOOP}:1/`] }), kv);
      const a = io();
      await pm.cli([], a.io);
      expect(a.out[0]).toBe("port forward 8443 set, but the public address couldn't be learned");
      expect(pm.state().forwarded).toBeNull();
    });
  });
});
