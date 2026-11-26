// Personal: which connections it talks through (the Stores Discord and WhatsApp, its own Instagram), its people's chats
// on them, the Personal list in data.json, and Add contact's one field resolved on the platform (never saved unresolved).
import { describe, expect, test } from "bun:test";
import { chatsFor, serves, type ConnMeta } from "../src/model/accounts.ts";
import { normalizeData } from "../src/model/data.ts";
import { contactHandleError, personalShares, resolveContact } from "../src/model/personal.ts";
import type { ChannelUser, LookupResult, Person } from "../src/model/types.ts";

const CONNS: ConnMeta[] = [
  { id: "stores", kind: "discord", section: "stores" },
  { id: "spokpay", kind: "discord", section: "spokpay" },
  { id: "creators-gmail-1", kind: "gmail", section: "creators" },
  { id: "creators-whatsapp-1", kind: "whatsapp", section: "creators" },
  { id: "stores-whatsapp-1", kind: "whatsapp", section: "stores" },
];
const at = "2026-11-26T12:00:00.000Z";
const person = (x: Partial<Person>): Person => ({ id: "p1", name: "Ana", discordId: "", storeIds: [], listIds: [], createdAt: at, updatedAt: at, ...x });
const user = (id: string, username: string, globalName: string | null = null, avatarUrl = ""): ChannelUser => ({ id, username, globalName, avatar: null, avatarUrl });

describe("personalShares", () => {
  test("the Stores Discord and the Stores WhatsApp serve Personal too; Personal gets its own Instagram", () => {
    const out = personalShares(CONNS, "personal-instagram-x");
    expect(out.find((c) => c.id === "stores")!.also).toEqual(["personal"]);
    expect(out.find((c) => c.id === "stores-whatsapp-1")!.also).toEqual(["personal"]);
    expect(out.find((c) => c.id === "spokpay")!.also).toBeUndefined();
    expect(out.find((c) => c.id === "creators-whatsapp-1")!.also).toBeUndefined();
    expect(out.at(-1)).toEqual({ id: "personal-instagram-x", kind: "instagram", section: "personal" });
  });
  test("once in place nothing changes (same array)", () => {
    const once = personalShares(CONNS, "personal-instagram-x");
    expect(personalShares(once, "personal-instagram-y")).toBe(once);
  });
  test("never Fagner's SpokPay Discord; another section's WhatsApp when Stores has none", () => {
    const out = personalShares([CONNS[1]!, CONNS[3]!], "ig");
    expect(out[0]!.also).toBeUndefined();
    expect(out[1]!.also).toEqual(["personal"]);
  });
  test("serves: its own section and the shared ones", () => {
    const [d] = personalShares(CONNS, "ig");
    expect(serves(d!, "stores")).toBe(true);
    expect(serves(d!, "personal")).toBe(true);
    expect(serves(d!, "creators")).toBe(false);
  });
});

describe("a Personal person's chats", () => {
  const conns = personalShares(CONNS, "personal-instagram-x");
  test("opened in Personal: the shared Stores Discord, WhatsApp and Instagram, by the identifiers they have", () => {
    const p = person({ listIds: ["personal"], discordId: "123456789012345678", whatsapp: "5511912345678", instagram: "4242" });
    expect(chatsFor(p, conns, "personal").map((c) => `${c.conn.id}:${c.peer}`)).toEqual(["stores:123456789012345678", "stores-whatsapp-1:5511912345678", "personal-instagram-x:4242"]);
  });
  test("from All people too; someone only in Stores doesn't get Personal's Instagram", () => {
    const p = person({ listIds: ["personal"], instagram: "4242" });
    expect(chatsFor(p, conns, null).map((c) => c.conn.id)).toEqual(["personal-instagram-x"]);
    const s = person({ storeIds: ["s1"], discordId: "123456789012345678", instagram: "4242" });
    expect(chatsFor(s, conns, "stores").map((c) => c.conn.id)).toEqual(["stores"]);
  });
});

describe("data.json", () => {
  test("Personal is added once, after the other lists; Instagram ids are kept", () => {
    const d = normalizeData({ version: 7, lists: [{ id: "creators", name: "Creators", accountId: "gmail" }, { id: "spokpay", name: "SpokPay", accountId: "spokpay" }], people: [{ id: "p1", name: "", discordId: "", instagram: "4242", instagramUsername: "@ana.s", listIds: ["personal"], storeIds: [] }] });
    expect(d.lists.map((l) => l.id)).toEqual(["creators", "spokpay", "personal"]);
    expect(d.lists[2]!.accountId).toBe("personal");
    expect(d.people[0]).toMatchObject({ instagram: "4242", instagramUsername: "ana.s", listIds: ["personal"] });
    expect(normalizeData(d).lists.map((l) => l.id)).toEqual(["creators", "spokpay", "personal"]);
  });
  test("settled in Personal and identities there survive a reload", () => {
    const d = normalizeData({ version: 7, people: [{ id: "p1", name: "Ana", discordId: "", listIds: ["personal"], storeIds: [], settled: { personal: at }, identities: [{ kind: "instagram", value: "4242", section: "personal" }] }] });
    expect(d.people[0]!.settled).toEqual({ personal: at });
    expect(d.people[0]!.identities).toEqual([{ kind: "instagram", value: "4242", section: "personal" }]);
  });
});

describe("Add contact: resolveContact", () => {
  const asked: string[] = [];
  const lookup = (r: LookupResult) => async (q: string) => {
    asked.push(q);
    return r;
  };
  test("WhatsApp: the number as typed, normalized, then found on WhatsApp", async () => {
    asked.length = 0;
    const r = await resolveContact("whatsapp", "(11) 91234-5678", lookup({ matches: [user("5511912345678", "+5511912345678", "Ana")] }));
    expect(asked).toEqual(["5511912345678"]);
    expect(r).toEqual({ id: "5511912345678", username: "+5511912345678", displayName: "Ana" });
  });
  test("WhatsApp: not on WhatsApp, or not a number: the reason, nothing found", async () => {
    await expect(resolveContact("whatsapp", "+55 11 91234-5678", lookup({ matches: [], notFound: true }))).rejects.toThrow("+5511912345678 isn’t on WhatsApp");
    await expect(resolveContact("whatsapp", "ana", lookup({ matches: [] }))).rejects.toThrow("isn’t a phone number");
    await expect(resolveContact("whatsapp", "+55 11 91234-5678", lookup({ matches: [], notes: ["WhatsApp isn’t connected"] }))).rejects.toThrow("WhatsApp isn’t connected");
  });
  test("Discord: only the exact username (any case), never a near match", async () => {
    const found = lookup({ matches: [user("123456789012345670", "ana_s2"), user("123456789012345678", "ana_s", "Ana S")] });
    expect(await resolveContact("discord", "@Ana_S", found)).toEqual({ id: "123456789012345678", username: "ana_s", displayName: "Ana S", avatar: null });
    await expect(resolveContact("discord", "ana", found)).rejects.toThrow("No Discord user @ana found");
    await expect(resolveContact("discord", "a b", found)).rejects.toThrow("A Discord username");
  });
  test("Discord: a user id is looked up as is", async () => {
    asked.length = 0;
    const r = await resolveContact("discord", "123456789012345678", lookup({ matches: [user("123456789012345678", "ana_s")] }));
    expect(asked).toEqual(["123456789012345678"]);
    expect(r.id).toBe("123456789012345678");
  });
  test("Instagram: username or profile link; the account's id and picture", async () => {
    asked.length = 0;
    const r = await resolveContact("instagram", "https://www.instagram.com/ana.s/?hl=en", lookup({ matches: [user("4242", "ana.s", "Ana", "https://scontent.cdninstagram.com/a.jpg")] }));
    expect(asked).toEqual(["ana.s"]);
    expect(r).toEqual({ id: "4242", username: "ana.s", displayName: "Ana", photo: "https://scontent.cdninstagram.com/a.jpg" });
    await expect(resolveContact("instagram", "@nobody", lookup({ matches: [], notFound: true }))).rejects.toThrow("No Instagram account @nobody found.");
  });
  test("empty fields say what to type", () => {
    expect(contactHandleError("whatsapp", " ")).toBe("Type their WhatsApp number");
    expect(contactHandleError("instagram", "")).toBe("Type their Instagram username");
    expect(contactHandleError("discord", "@ana.s")).toBeNull();
  });
});
