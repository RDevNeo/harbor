import { expect, test } from "bun:test";
import { parseIp, routeTo, type Ip } from "../src/ip.ts";

const ip = (s: string): Ip => {
  const p = parseIp(s);
  if (!p) throw new Error(s);
  return p;
};
const HEAD4 = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";
const lan = [10, 1, 2].join(".");
const v4 = `${HEAD4}\neth0\t00000000\t01020A0A\t0003\t0\t0\t600\t00000000\t0\t0\t0\neth0\t0002010A\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n`;
const subnetOnly = `${HEAD4}\neth0\t0002010A\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n`;
const rejectV6 = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo\n";
const v6Route = "fd000000000000000000000000000000 08 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001     eth0\n";

test("a default route reaches everything; a subnet route only its subnet", () => {
  expect(routeTo(ip(`${lan}.7`), { v4, v6: "" })).toBe(true);
  expect(routeTo(ip([10, 9, 9, 9].join(".")), { v4, v6: "" })).toBe(true);
  expect(routeTo(ip(`${lan}.7`), { v4: subnetOnly, v6: "" })).toBe(true);
  expect(routeTo(ip([10, 9, 9, 9].join(".")), { v4: subnetOnly, v6: "" })).toBe(false);
});

test("a namespace with only lo routes nowhere but to itself (the IPv6 default there is a reject route)", () => {
  const ns = { v4: `${HEAD4}\n`, v6: rejectV6 };
  expect(routeTo(ip([10, 0, 0, 9].join(".")), ns)).toBe(false);
  expect(routeTo(ip("fd00::9"), ns)).toBe(false);
  expect(routeTo(ip("127.0.0.1"), ns)).toBe(true);
  expect(routeTo(ip("::1"), ns)).toBe(true);
  expect(routeTo(ip([10, 0, 0, 9].join(".")), ns, [ip([10, 0, 0, 9].join("."))])).toBe(true);
});

test("an IPv6 route matches by its prefix", () => {
  expect(routeTo(ip("fd12::1"), { v4: "", v6: v6Route })).toBe(true);
  expect(routeTo(ip("2001:db8::1"), { v4: "", v6: v6Route })).toBe(false);
});
