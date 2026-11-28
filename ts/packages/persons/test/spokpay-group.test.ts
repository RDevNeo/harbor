// SpokPay › Clients and Leads (model/spokpay-group.ts): version 8 makes SpokPay's people Clients once (the version 7
// file kept beside it), whoever joins SpokPay afterwards is a Lead (Add, Move to, a link, Collector's sends), Move to
// Clients / Move to Leads over the API, and leaving SpokPay drops it. Nothing is sent anywhere.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinScope, normalizeData } from "../src/model/data.ts";
import { linkPeople } from "../src/model/link.ts";
import { movePerson } from "../src/model/move.ts";
import { groupOf, migrateClients, setGroup, tidyGroups } from "../src/model/spokpay-group.ts";
import type { AppData, Person } from "../src/model/types.ts";
import { PersonsRoutes } from "../src/routes.ts";
import { PersonsService } from "../src/service.ts";
import { DataFile } from "../src/store.ts";
import { livePersons } from "../../../tabs/collector/persons-bridge.ts";
import { personKeys } from "../../../tabs/collector/lib/identity.ts";

const T0 = "2026-11-20T10:00:00.000Z";
const LISTS = [{ id: "creators", name: "Creators", accountId: "gmail" }, { id: "spokpay", name: "SpokPay", accountId: "spokpay" }];
const person = (id: string, listIds: string[], more: Partial<Person> = {}): Person => ({ id, name: id.toUpperCase(), discordId: "", storeIds: [], listIds, createdAt: T0, updatedAt: T0, ...more });
const v7 = (people: Person[]) => ({ version: 7, updatedAt: T0, readSince: T0, stores: [], lists: LISTS, people });

const dirs: string[] = [];
const services: PersonsService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hub-spokpay-group-"));
  dirs.push(d);
  return d;
};

describe("the version 8 migration", () => {
  it("makes everyone in SpokPay a Client, and no one else", () => {
    const d = normalizeData(v7([person("a", ["spokpay"]), person("b", ["creators"]), person("c", ["creators", "spokpay"])]));
    expect(d.version).toBe(8);
    expect(d.people.map((p) => [p.id, p.spokpayGroup ?? null, groupOf(p)])).toEqual([["a", "clients", "clients"], ["b", null, null], ["c", "clients", "clients"]]);
  });
  it("runs once: a version 8 file keeps its Leads (missing = Lead) and its Clients", () => {
    const once = normalizeData(v7([person("a", ["spokpay"])]));
    const withLead = { ...once, people: [...once.people, person("n", ["spokpay"])] };
    const again = normalizeData(JSON.parse(JSON.stringify(withLead)));
    expect(again.people.map((p) => groupOf(p))).toEqual(["clients", "leads"]);
    expect(normalizeData(JSON.parse(JSON.stringify(again)))).toEqual(again);
    // and the marking itself never changes someone who has one
    expect(migrateClients([person("x", ["spokpay"], { spokpayGroup: "leads" })])[0]!.spokpayGroup).toBe("leads");
  });
  it("drops a sub-category outside SpokPay and odd values", () => {
    const d = normalizeData({ ...v7([]), version: 8, people: [person("a", ["creators"], { spokpayGroup: "clients" }), { ...person("b", ["spokpay"]), spokpayGroup: "vip" }] });
    expect(d.people.map((p) => p.spokpayGroup ?? null)).toEqual([null, null]);
    expect(groupOf(d.people[1]!)).toBe("leads");
  });
  it("DataFile: backs the version 7 file up once, writes version 8, and a second load changes nothing", () => {
    const dir = tmp();
    const text = JSON.stringify(v7([person("a", ["spokpay"]), person("b", ["creators"])]));
    writeFileSync(join(dir, "data.json"), text);
    const d = new DataFile(dir).load();
    expect(d.people[0]!.spokpayGroup).toBe("clients");
    expect(readFileSync(join(dir, "data.before-v8.json"), "utf8")).toBe(text);
    const saved = readFileSync(join(dir, "data.json"), "utf8");
    expect(JSON.parse(saved).version).toBe(8);
    expect(JSON.parse(saved).people[0].spokpayGroup).toBe("clients");
    // idempotent: loaded again, nothing is rewritten and the backup stays the version 7 file
    new DataFile(dir).load();
    expect(readFileSync(join(dir, "data.json"), "utf8")).toBe(saved);
    expect(readFileSync(join(dir, "data.before-v8.json"), "utf8")).toBe(text);
  });
  it("DataFile: no backup for a new or a current file", () => {
    const dir = tmp();
    new DataFile(dir).load();
    writeFileSync(join(dir, "data.json"), JSON.stringify({ ...v7([]), version: 8 }));
    new DataFile(dir).load();
    expect(existsSync(join(dir, "data.before-v8.json"))).toBe(false);
  });
});

describe("joining SpokPay makes a Lead", () => {
  const data = (people: Person[]): AppData => ({ version: 8, people, stores: [], lists: LISTS as AppData["lists"], updatedAt: T0 });
  it("joinScope (Add, Collector's Send / Approve) and Move to", () => {
    expect(groupOf(joinScope(person("a", []), { kind: "list", id: "spokpay" }, T0))).toBe("leads");
    // a Client who left and comes back is a Lead again
    expect(groupOf(joinScope(person("a", ["creators"], { spokpayGroup: "clients" }), { kind: "list", id: "spokpay" }, T0))).toBe("leads");
    // already there: stays as they are
    const client = person("c", ["spokpay"], { spokpayGroup: "clients" });
    expect(joinScope(client, { kind: "list", id: "spokpay" }, T0)).toBe(client);
    const moved = movePerson(data([person("a", ["creators"])]), "a", null, { section: "spokpay" }, T0)!;
    expect(groupOf(moved.data.people[0]!)).toBe("leads");
  });
  it("Move to elsewhere drops it; moving back makes a Lead", () => {
    const out = movePerson(data([person("c", ["spokpay"], { spokpayGroup: "clients" })]), "c", { section: "spokpay" }, { section: "creators" }, T0)!;
    expect(out.data.people[0]!.spokpayGroup).toBeUndefined();
    const back = movePerson(out.data, "c", null, { section: "spokpay" }, T0)!;
    expect(groupOf(back.data.people[0]!)).toBe("leads");
  });
  it("Link: joining SpokPay through a Client keeps them a Client", () => {
    const r = linkPeople(data([person("a", ["creators"]), person("c", ["spokpay"], { spokpayGroup: "clients" })]), "a", ["c"], T0);
    expect(r && groupOf(r.data.people.find((p) => p.id === "a")!)).toBe("clients");
  });
  it("setGroup and tidyGroups", () => {
    const lead = person("l", ["spokpay"]);
    expect(groupOf(setGroup(lead, "clients", T0))).toBe("clients");
    expect(setGroup(lead, "leads", T0)).toBe(lead);
    expect(setGroup(person("x", ["creators"]), "clients", T0).spokpayGroup).toBeUndefined();
    const d = data([lead, person("o", ["creators"], { spokpayGroup: "clients" })]);
    const t = tidyGroups(d);
    expect(t.people[1]!.spokpayGroup).toBeUndefined();
    expect(t.people[0]).toBe(lead);
    expect(tidyGroups(t)).toBe(t);
  });
});

async function service(people: Person[]) {
  const dir = tmp();
  writeFileSync(join(dir, "data.json"), JSON.stringify(v7(people)));
  writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [] }));
  const s = new PersonsService({ dir, offline: true });
  services.push(s);
  await s.start();
  const r = new PersonsRoutes(s);
  const call = async (method: string, path: string, body: unknown = null) => (await r.route({ method, path: ["v1", "persons", ...path.split("/")], query: [], body }))!;
  return { dir, s, call };
}

describe("over the API", () => {
  it("the state says Clients or Leads; Move to Clients / Move to Leads; 400 outside SpokPay", async () => {
    const { s, call } = await service([person("old", ["spokpay"]), person("cr", ["creators"])]);
    const groups = async () => Object.fromEntries(((await call("GET", "state")).body as { people: { id: string; spokpayGroup: string | null }[] }).people.map((p) => [p.id, p.spokpayGroup]));
    expect(await groups()).toEqual({ old: "clients", cr: null });
    // a new person in SpokPay (Add person) is a Lead
    const made = (await call("POST", "people", { name: "Nova", listIds: ["spokpay"] })).body as { person: { id: string } };
    expect((await groups())[made.person.id]).toBe("leads");
    expect((await call("PATCH", `person/${made.person.id}`, { spokpayGroup: "clients" })).status).toBe(200);
    expect(groupOf(s.person(made.person.id)!)).toBe("clients");
    expect((await call("PATCH", "person/old", { spokpayGroup: "leads" })).status).toBe(200);
    expect((await groups()).old).toBe("leads");
    expect((await call("PATCH", "person/cr", { spokpayGroup: "clients" })).status).toBe(400);
    expect((await call("PATCH", "person/old", { spokpayGroup: "vip" })).status).toBe(400);
    // Move to Creators drops it, Move back to SpokPay is a Lead
    await call("POST", "person/old/move", { to: "creators", from: "spokpay" });
    expect(s.person("old")!.spokpayGroup).toBeUndefined();
    await call("POST", "person/old/move", { to: "spokpay" });
    expect((await groups()).old).toBe("leads");
    // the panel has it too
    expect(((await call("GET", `person/${made.person.id}`)).body as { spokpayGroup: string }).spokpayGroup).toBe("clients");
  });
  it("Collector: Approve / Send to \"spokpay\" lands in Leads (a Client stays one); never-twice covers Clients and Leads", async () => {
    const { s } = await service([person("cl", ["spokpay"], { email: "client@x.com" })]);
    const bridge = livePersons(() => s);
    const rec = (id: string, email: string) => ({ platform: "youtube", platform_id: id, name: id, handle: `@${id}`, profile_url: `https://www.youtube.com/@${id}`, email, links: [], discovered_via: "t" }) as never;
    const added = bridge.add(rec("ana", "ana@x.com"), "spokpay");
    expect(added).toMatchObject({ ok: true, created: true });
    expect(groupOf(s.person(added.person!)!)).toBe("leads");
    // the Client joined again by Collector stays a Client
    expect(bridge.add(rec("cli", "client@x.com"), "spokpay")).toMatchObject({ ok: true, person: "cl", created: false });
    expect(groupOf(s.person("cl")!)).toBe("clients");
    const keys = bridge.creatorKeys(["spokpay"]);
    for (const k of [...personKeys({ emails: ["client@x.com"], links: [] }), ...personKeys({ emails: ["ana@x.com"], links: [] })]) expect(keys).toContain(k);
    // not a place Collector sent to: not known
    expect(bridge.creatorKeys([])).not.toContain(personKeys({ emails: ["ana@x.com"], links: [] })[0]);
  });
});
