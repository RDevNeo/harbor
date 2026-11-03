import { expect, test } from "bun:test";
import { AccountHub, events, tell, type HubCtx, type HubNamespace } from "../../../../worker/src/accounthub.js";

function ctx() {
  const data = new Map<string, unknown>();
  const sent: string[] = [];
  const c: HubCtx = {
    storage: { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) },
    getWebSockets: () => [{ send: (m: string) => void sent.push(m) }],
  };
  return { c, sent, data };
}

const body = async (r: Response) => (r.status === 204 ? null : ((await r.json()) as { seq: number; what: string }));

test("a change reaches the open sockets and the waiting polls, counted by seq", async () => {
  const { c, sent, data } = ctx();
  const hub = new AccountHub(c, { EVENTS_WAIT_MS: "2000" });
  // A device that just came: the current seq at once.
  expect(await body(await hub.fetch(new Request("https://hub/wait")))).toEqual({ seq: 0, what: "hello" });
  const waiting = hub.fetch(new Request("https://hub/wait?since=0"));
  await Bun.sleep(30);
  await hub.fetch(new Request("https://hub/notify", { method: "POST", body: JSON.stringify({ what: "invites" }) }));
  expect(await body(await waiting)).toEqual({ seq: 1, what: "invites" });
  expect(sent.map((m) => JSON.parse(m))).toEqual([{ seq: 1, what: "invites" }]);
  expect(data.get("seq")).toBe(1);
  // Behind: at once; anything but invites counts as the directory.
  expect(await body(await hub.fetch(new Request("https://hub/wait?since=0")))).toEqual({ seq: 1, what: "hello" });
  await hub.fetch(new Request("https://hub/notify", { method: "POST", body: "{}" }));
  expect(JSON.parse(sent.at(-1) ?? "")).toEqual({ seq: 2, what: "directory" });
  // Nothing changes: 204 after the wait.
  const quiet = await new AccountHub(c, { EVENTS_WAIT_MS: "50" }).fetch(new Request("https://hub/wait?since=2"));
  expect(quiet.status).toBe(204);
  // A PC's socket wants an upgrade.
  expect((await hub.fetch(new Request("https://hub/socket"))).status).toBe(426);
});

test("tell pings each account once, events picks the account's object", async () => {
  const asked: string[] = [];
  const ns: HubNamespace = {
    idFromName: (n) => n,
    get: (id) => ({ fetch: async (url: string, init?: RequestInit) => (asked.push(`${String(id)} ${url} ${String(init?.body ?? "")}`), new Response("{}")) }),
  };
  await tell({ ACCOUNT_HUB: ns }, ["u1", "u2", "u1", ""], "directory");
  expect(asked).toEqual(['u1 https://hub/notify {"what":"directory"}', 'u2 https://hub/notify {"what":"directory"}']);
  await tell({}, ["u1"], "invites");
  asked.length = 0;
  await events(new Request("https://w/v1/events?since=4"), { ACCOUNT_HUB: ns }, "u9");
  await events(new Request("https://w/v1/events"), { ACCOUNT_HUB: ns }, "u9");
  expect(asked).toEqual(["u9 https://hub/wait?since=4 ", "u9 https://hub/wait "]);
});
