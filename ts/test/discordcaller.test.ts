import { expect, test } from "bun:test";
import { discordCaller } from "../hub.ts";

type It = { kind: string; name?: string; result?: string | null };

function engine(running: Record<number, It[]>) {
  const turns = new Map(Object.keys(running).map((k) => [Number(k), {}]));
  return {
    turns,
    transcript: (id: number) => ({ items: running[id] ?? [] }),
    chat: (id: number) => ({ id, gid: `pc:${id}` }),
  } as unknown as Parameters<typeof discordCaller>[0];
}

const join = (result: string | null): It => ({ kind: "tool", name: "mcp__discord__discord_join", result });

test("the chat a captcha belongs to is the one running turn waiting on a Discord join", () => {
  expect(discordCaller(engine({ 3: [{ kind: "text" }, join(null)], 4: [join("done")] }))?.id).toBe(3);
  // The join already answered, or the newest call is something else: not this one.
  expect(discordCaller(engine({ 3: [join(null), { kind: "tool", name: "Bash", result: null }] }))).toBeUndefined();
  // Two chats waiting: can't tell, so the overlay shows it.
  expect(discordCaller(engine({ 3: [join(null)], 5: [join(null)] }))).toBeUndefined();
  expect(discordCaller(engine({}))).toBeUndefined();
});
