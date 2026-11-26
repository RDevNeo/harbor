import { describe, expect, it } from "bun:test";
import type { SrThread } from "../src/spokpay-core.ts";
import { dateEnglish, factRows, finishWords, paneView, relativeEnglish } from "../src/srpane.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 26, 12);

const thread = (extra: Partial<SrThread["siteRequest"]> = {}, messages: SrThread["messages"] = [], events: SrThread["events"] = []): SrThread => ({
  siteRequest: {
    ref: "SR-215",
    category: "website",
    subject: "Avaliações novas não aparecem no site",
    status: "working",
    store: { name: "Wiz Store", slug: "wiz" },
    waitingOn: "spokpay",
    summary: "",
    brief: { change: "Mostrar as novas", where: "Home", references: "", deadline: "Sexta", outcome: "Aparecem" },
    attachments: [],
    createdAt: NOW - 7 * 24 * H,
    lastActivityAt: NOW - H,
    ...extra,
  },
  messages,
  events,
  hasMore: false,
});
const msg = (id: string, side: "store" | "spokpay", authorName: string, at: number, text = "oi"): SrThread["messages"][number] => ({ messageId: id, side, authorName, text, attachments: [], createdAt: at });

describe("srpane", () => {
  it("words times as SpokPay's admin page does", () => {
    expect(relativeEnglish(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeEnglish(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(relativeEnglish(NOW - 7 * H, NOW)).toBe("7 h ago");
    expect(relativeEnglish(NOW - 30 * H, NOW)).toBe("Yesterday");
    expect(relativeEnglish(NOW - 3 * 24 * H, NOW)).toBe("3 days ago");
    expect(relativeEnglish(Date.UTC(2026, 10, 19, 12), NOW)).toBe(dateEnglish(Date.UTC(2026, 10, 19, 12)));
    expect(dateEnglish(new Date(2026, 10, 19, 12).getTime())).toBe("19 Nov 2026");
  });

  it("builds the header, the brief and the status choices", () => {
    const v = paneView(thread({}, [], [{ event: "opened_by_spokpay", createdAt: NOW - 7 * 24 * H }]), { now: NOW, summary: "Clientes avaliaram e não aparece", ownerEmail: "dono@x.com" });
    expect(v).toMatchObject({ ref: "SR-215", statusLabel: "Working", tone: "info", store: "Wiz Store", finished: false, placeholder: "Write to dono@x.com" });
    expect(v.brief.sub).toBe(`Website · Opened by SpokPay · ${dateEnglish(NOW - 7 * 24 * H)}`);
    expect(v.brief.summary).toBe("Clientes avaliaram e não aparece");
    expect(v.brief.facts.map((f) => f.label)).toEqual(["What changes", "Where", "Deadline", "Expected outcome"]);
    expect(factRows(v.brief.facts).map(([a, b]) => [a.label, b?.label ?? null])).toEqual([["What changes", null], ["Where", "Deadline"], ["Expected outcome", null]]);
    expect(v.statuses).toEqual([
      { status: "working", label: "Working", current: true },
      { status: "review", label: "Waiting review", current: false },
      { status: "completed", label: "Completed", current: false },
      { status: "closed", label: "Closed", current: false },
    ]);
  });

  it("puts events between messages and groups one author's run within an hour", () => {
    const v = paneView(
      thread({}, [msg("a", "store", "Truth", NOW - 9 * H), msg("b", "store", "Truth", NOW - 8.5 * H), msg("c", "store", "Truth", NOW - 7.5 * H), msg("d", "spokpay", "Igor", NOW - 2 * H)], [
        { event: "sent", createdAt: NOW - 9 * H },
        { event: "started", createdAt: NOW - 3 * H },
      ]),
      { now: NOW },
    );
    expect(v.items.map((i) => (i.kind === "event" ? i.text : `${i.id}:${i.joinsPrev ? "<" : ""}${i.joinsNext ? ">" : ""}`))).toEqual(["Sent to SpokPay · 9 h ago", "a:>", "b:<", "c:", "Work started · 3 h ago", "d:"]);
    const d = v.items.at(-1);
    expect(d?.kind === "msg" && d.mine && d.head).toBe("Igor · 2 h ago");
    expect(v.placeholder).toBe("Write to Truth");
    expect(v.brief.sub).toContain("From Wiz Store");
  });

  it("is final once completed or closed, and says why a key can't act", () => {
    const v = paneView(thread({ status: "completed" }), { now: NOW, permissions: { "site-requests:write": false } });
    expect(v.finished).toBe(true);
    expect(v.statuses).toEqual([{ status: "completed", label: "Completed", current: true }]);
    expect(v.finishedNote).toBe("This request is completed. The store opens a new one if something else comes up.");
    expect(v.writeBlocked).toMatch(/site-requests:write/);
    expect(v.statusBlocked).toBeNull();
    expect(finishWords("closed", "Wiz Store").ok).toBe("Close request");
  });

  it("keeps pictures apart from other files, with Hub's route for their bytes", () => {
    const v = paneView(thread({ attachments: [{ url: "https://cdn/x.png", name: "x.png", contentType: "image/png" }, { url: "https://cdn/a.pdf", name: "a.pdf", contentType: "application/pdf" }, { url: null, name: "gone", contentType: null }] }), {
      now: NOW,
      imageRoute: (u) => `/img?u=${u}`,
    });
    expect(v.brief.files).toEqual([
      { url: "https://cdn/x.png", name: "x.png", image: true, src: "/img?u=https://cdn/x.png" },
      { url: "https://cdn/a.pdf", name: "a.pdf", image: false, src: null },
    ]);
  });
});
