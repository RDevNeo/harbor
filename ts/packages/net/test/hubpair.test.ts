import { describe, expect, test } from "bun:test";
import { CODE_TTL_MS, hubPhoneAuth, HubPairing, pairAddrs, pairLink, parsePairLink } from "../src/hubpair.ts";

const kv = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), m };
};
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

describe("Hub pairing", () => {
  test("a code pairs one phone once; its token works only from its key", () => {
    let now = 1_000_000;
    const p = new HubPairing(kv(), () => now);
    expect(p.pair("X", FP_A, "Pixel").ok).toBe(false);
    const { code } = p.start();
    expect(code).toMatch(/^[A-Z2-7]{10}$/);
    expect(p.pair("WRONGCODE1", FP_A, "Pixel").ok).toBe(false);
    const r = p.pair(code.toLowerCase().slice(0, 5) + "-" + code.slice(5), FP_A, "Pixel");
    if (!r.ok) throw new Error(r.error);
    expect(r.token.startsWith("hubd_")).toBe(true);
    expect(p.pair(code, FP_B, "Other").ok).toBe(false); // used up
    const auth = p.auth();
    expect(auth.isToken(r.token)).toBe(true);
    expect(auth.admit(r.token, FP_A).name).toBe("Pixel");
    expect(() => auth.admit(r.token, FP_B)).toThrow();
    expect(auth.knownDevice(FP_A)).toBe(true);
    expect(p.byKey(FP_A)?.sub).toBe(`hub:${FP_A}`);
    expect(p.byKey(FP_B)).toBeNull();
    // only the hash is kept
    expect(JSON.stringify(p.devices())).not.toContain(r.token);
    now += 1;
  });

  test("codes expire, and a removed phone is out", () => {
    let now = 0;
    const p = new HubPairing(kv(), () => now);
    const { code } = p.start();
    now += CODE_TTL_MS + 1;
    expect(p.pair(code, FP_A, "x").ok).toBe(false);
    const c2 = p.start().code;
    const r = p.pair(c2, FP_A, "x");
    expect(r.ok).toBe(true);
    expect(p.revoke(FP_A)).toBe(true);
    expect(p.byKey(FP_A)).toBeNull();
    if (r.ok) expect(() => p.auth().admit(r.token, FP_A)).toThrow();
  });

  test("the link round-trips (android/PROTOCOL.md Hub pairing)", () => {
    const info = { name: "Igor PC", id: "ts:abc", fp: FP_A, addrs: ["192.168.0.5:47950", "100.90.1.2:47950"], code: "ABCDE23456" };
    const link = pairLink(info);
    expect(link.startsWith("hub://pair?fp=")).toBe(true);
    expect(parsePairLink(link)).toEqual(info);
    expect(parsePairLink("harbor://pair?fp=x")).toBeNull();
  });

  test("addresses: LAN v4, then Tailscale, then v6; no loopback", () => {
    expect(pairAddrs(["100.90.1.2", "127.0.0.1", "192.168.0.5", "fe80::1", "2001:db8::1", "::1"], 47950)).toEqual(["192.168.0.5:47950", "100.90.1.2:47950", "[2001:db8::1]:47950"]);
  });

  test("a pairing token or, with Hub's account service, a sign-in", () => {
    const p = new HubPairing(kv());
    const acct = { isToken: (t: string) => t.startsWith("eyJ"), admit: () => ({ sub: "user_1", email: "a@b", name: "A" }), knownDevice: (fp: string) => fp === FP_B };
    const both = hubPhoneAuth(p.auth(), acct);
    expect(both.isToken("eyJx")).toBe(true);
    expect(both.admit("eyJx", FP_B).sub).toBe("user_1");
    expect(both.knownDevice(FP_B)).toBe(true);
    const alone = hubPhoneAuth(p.auth(), null);
    expect(alone.isToken("eyJx")).toBe(false);
  });
});
