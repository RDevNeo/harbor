import { describe, expect, it } from "bun:test";
import { contactHref, contactOfUrl, contactsInText, contactsOf, contactText, findContacts, phoneOf, refreshContacts, typedContact } from "../lib/contacts.ts";
import { exportRecord, migrate, type CreatorRecord } from "../lib/types.ts";
import { reachDrafts, reachStart } from "../lib/reach.ts";

const lead = (over: Partial<CreatorRecord> = {}): CreatorRecord => ({
  platform: "youtube",
  platform_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
  name: "Axel",
  handle: "@axel",
  profile_url: "https://youtube.com/@axel",
  avatar_url: null,
  subscriber_count: 21300,
  video_count: null,
  view_count: null,
  description: null,
  links: [],
  country: null,
  discovered_via: "roblox",
  captured_at: "2026-11-25T12:00:00Z",
  ...over,
});

describe("contacts: links", () => {
  it("reads WhatsApp, Discord and Instagram links", () => {
    expect(contactOfUrl("https://wa.me/5511987654321")).toEqual({ kind: "whatsapp", value: "+5511987654321" });
    expect(contactOfUrl("https://api.whatsapp.com/send?phone=5521975709440&text=oi")).toEqual({ kind: "whatsapp", value: "+5521975709440" });
    expect(contactOfUrl("https://wa.me/11987654321")).toEqual({ kind: "whatsapp", value: "+5511987654321" });
    expect(contactOfUrl("https://discord.gg/AbC123")).toEqual({ kind: "discord", value: "discord.gg/AbC123" });
    expect(contactOfUrl("https://discord.com/invite/xyz-9")).toEqual({ kind: "discord", value: "discord.gg/xyz-9" });
    expect(contactOfUrl("https://discord.com/users/123456789012345678")).toEqual({ kind: "discord", value: "123456789012345678" });
    expect(contactOfUrl("https://instagram.com/Axel.Crd")).toEqual({ kind: "instagram", value: "@axel.crd" });
    expect(contactOfUrl("mailto:Contato@Axel.com.br")).toEqual({ kind: "email", value: "contato@axel.com.br" });
  });
  it("leaves out what isn't a contact", () => {
    expect(contactOfUrl("https://wa.me/message/ABCDEF")).toBeNull();
    expect(contactOfUrl("https://chat.whatsapp.com/Gr0up")).toBeNull();
    expect(contactOfUrl("https://instagram.com/p/Cxyz")).toBeNull();
    expect(contactOfUrl("https://discord.com/channels/1/2")).toBeNull();
    expect(contactOfUrl("https://youtube.com/@axel")).toBeNull();
  });
});

describe("contacts: bio text", () => {
  it("finds a labelled Brazilian WhatsApp number", () => {
    expect(contactsInText("Parcerias no WhatsApp: (11) 98765-4321")).toEqual([{ kind: "whatsapp", value: "+5511987654321" }]);
    expect(contactsInText("📱 Zap - 21 97570 9440")).toEqual([{ kind: "whatsapp", value: "+5521975709440" }]);
    expect(contactsInText("wpp +55 31 3333-4444")).toEqual([{ kind: "whatsapp", value: "+553133334444" }]);
    // a number without a label is not a WhatsApp
    expect(contactsInText("Ligue (11) 98765-4321")).toEqual([]);
    // "zapzap" is WhatsApp too; a label inside another word isn't
    expect(contactsInText("zapzap 11987654321")).toEqual([{ kind: "whatsapp", value: "+5511987654321" }]);
    expect(contactsInText("Bazap 11987654321")).toEqual([]);
  });
  it("finds a labelled Discord username, not a word or a link", () => {
    expect(contactsInText("Discord: axel_crd")).toEqual([{ kind: "discord", value: "axel_crd" }]);
    expect(contactsInText("discord - Axel.Crd.")).toEqual([{ kind: "discord", value: "axel.crd" }]);
    expect(contactsInText("Discord: servidor da comunidade")).toEqual([]);
    expect(contactsInText("Discord: https://discord.gg/abc")).toEqual([{ kind: "discord", value: "discord.gg/abc" }]);
    expect(contactsInText("Entra no discord.gg/abc")).toEqual([{ kind: "discord", value: "discord.gg/abc" }]);
  });
  it("finds an @Instagram after its label", () => {
    expect(contactsInText("Instagram: @axelcrd")).toEqual([{ kind: "instagram", value: "@axelcrd" }]);
    expect(contactsInText("IG 👉 @Axel.Crd")).toEqual([{ kind: "instagram", value: "@axel.crd" }]);
    expect(contactsInText("me segue @axelcrd")).toEqual([]);
    expect(contactsInText("instagram.com/axelcrd")).toEqual([{ kind: "instagram", value: "@axelcrd" }]);
  });
  it("finds emails, gmail or any", () => {
    expect(contactsInText("contato: axel [arroba] gmail [ponto] com")).toEqual([{ kind: "email", value: "axel@gmail.com" }]);
  });
});

describe("contacts: a creator's", () => {
  it("keeps each with its source, once, email first", () => {
    const got = findContacts({
      text: "Parcerias: axel@gmail.com\nZap: (11) 98765-4321\nInstagram: @axelcrd",
      textSource: "YouTube About",
      links: [
        { label: "Instagram", url: "https://instagram.com/axelcrd" },
        { label: "Discord", url: "https://discord.gg/axel", source: "linktr.ee/axel" },
        { label: null, url: "https://wa.me/5511987654321", source: "linktr.ee/axel" },
      ],
      emails: [{ email: "biz@axel.com.br", source: "site axel.com.br" }],
    });
    expect(got).toEqual([
      { kind: "email", value: "biz@axel.com.br", source: "site axel.com.br" },
      { kind: "email", value: "axel@gmail.com", source: "YouTube About" },
      { kind: "whatsapp", value: "+5511987654321", source: "YouTube About" },
      { kind: "instagram", value: "@axelcrd", source: "YouTube About" },
      { kind: "discord", value: "discord.gg/axel", source: "linktr.ee/axel" },
    ]);
  });
  it("puts typed ones first, then found, then an Instagram lead's own profile", () => {
    const c = lead({
      email: "found@x.com",
      email_source: "YouTube About",
      whatsapp: "5511987654321",
      reach: { kind: "discord", value: "123456789012345678" },
      contacts: [
        { kind: "instagram", value: "@typed", source: "typed", manual: true },
        { kind: "whatsapp", value: "+5511987654321", source: "linktr.ee/x" },
        { kind: "discord", value: "discord.gg/x", source: "YouTube About" },
      ],
    });
    expect(contactsOf(c).map((x) => `${x.kind} ${x.value} ${x.source}`)).toEqual([
      "discord 123456789012345678 typed",
      "instagram @typed typed",
      "email found@x.com YouTube About",
      "whatsapp +5511987654321 linktr.ee/x",
      "discord discord.gg/x YouTube About",
    ]);
    const ig = lead({ platform: "instagram", handle: "Axel" });
    expect(contactsOf(ig)).toEqual([{ kind: "instagram", value: "@axel", source: "Instagram profile" }]);
    expect(contactsOf(lead())).toEqual([]);
  });
  it("shows and opens them", () => {
    expect(contactText({ kind: "whatsapp", value: "+5511987654321" })).toBe("+55 11 98765-4321");
    expect(contactHref({ kind: "whatsapp", value: "+5511987654321" })).toBe("https://wa.me/5511987654321");
    expect(contactHref({ kind: "discord", value: "discord.gg/x" })).toBe("https://discord.gg/x");
    expect(contactHref({ kind: "discord", value: "axel_crd" })).toBeNull();
    expect(contactHref({ kind: "instagram", value: "@axel" })).toBe("https://www.instagram.com/axel/");
    expect(contactHref({ kind: "email", value: "a@b.co" })).toBeNull();
  });
  it("checks what's typed", () => {
    expect(typedContact("whatsapp", "(11) 98765-4321")).toEqual({ value: "+5511987654321", error: "" });
    expect(typedContact("whatsapp", "https://wa.me/5511987654321").value).toBe("+5511987654321");
    expect(typedContact("whatsapp", "123").error).not.toBe("");
    expect(typedContact("discord", "https://discord.gg/Abc")).toEqual({ value: "discord.gg/Abc", error: "" });
    expect(typedContact("discord", "@Axel_Crd")).toEqual({ value: "axel_crd", error: "" });
    expect(typedContact("instagram", "instagram.com/AxelCrd")).toEqual({ value: "@axelcrd", error: "" });
    expect(typedContact("email", "A@Gmail.com")).toEqual({ value: "a@gmail.com", error: "" });
    expect(typedContact("email", "nope").error).not.toBe("");
    expect(phoneOf("0800 123 4567")).toBeNull();
  });
});

describe("contacts: stored leads", () => {
  it("backfills an older lead from its bio and links, once, nothing fetched", () => {
    const d = migrate({ creators: [lead({ description: "Zap: 11 98765-4321", links: [{ label: "Discord", url: "https://discord.gg/axel" }] })] });
    const c = d.creators[0]!;
    expect(c.contacts).toEqual([
      { kind: "whatsapp", value: "+5511987654321", source: "YouTube About" },
      { kind: "discord", value: "discord.gg/axel", source: "YouTube About" },
    ]);
    expect(c.whatsapp).toBe("5511987654321");
    // a saved list is kept as is
    expect(migrate({ creators: [{ ...c, contacts: [] }] }).creators[0]!.contacts).toEqual([]);
  });
  it("never replaces a typed one on a new read", () => {
    const c = lead({ description: "WhatsApp 21 97570-9440", whatsapp: "5511900001111", whatsapp_manual: true, contacts: [{ kind: "instagram", value: "@mine", source: "typed", manual: true }] });
    refreshContacts(c);
    expect(c.whatsapp).toBe("5511900001111");
    expect(contactsOf(c).map((x) => x.value)).toEqual(["@mine", "+5511900001111", "+5521975709440"]);
  });
  it("keeps contacts out of the CRM's JSONL", () => {
    const out = exportRecord(lead({ contacts: [{ kind: "discord", value: "discord.gg/x", source: "bio" }], whatsapp: "5511987654321" }));
    expect(out.contacts).toBeUndefined();
    expect(out.whatsapp).toBeUndefined();
  });
  it("opens the detail's Reach on their best contact, with a found Discord ID ready", () => {
    const c = lead({ contacts: [{ kind: "discord", value: "123456789012345678", source: "linktr.ee/x" }] });
    expect(reachStart(c)).toBe("discord");
    expect(reachDrafts(c).discord).toBe("123456789012345678");
  });
});
