// Preloaded by offline.test.ts: every outbound connection is refused and written to $HARBOR_TEST_TRAP.
// Unix sockets stay open: they are this PC's own (the control socket).
import { appendFileSync } from "node:fs";
import dgram from "node:dgram";
import net from "node:net";

const log = process.env.HARBOR_TEST_TRAP ?? "";
const note = (what: string): void => {
  if (log !== "") appendFileSync(log, `${what}\n`);
};
const refused = (): Error => new Error("refused by the offline test");

const fetchTrap = async (input: string | URL | Request): Promise<Response> => {
  note(`fetch ${input instanceof Request ? input.url : String(input)}`);
  throw refused();
};
globalThis.fetch = Object.assign(fetchTrap, { preconnect: () => undefined });

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  const [first] = args;
  const local = typeof first === "string" || (typeof first === "object" && first !== null && "path" in first && typeof first.path === "string");
  if (local) return connect.apply(this, args as Parameters<typeof connect>);
  note(`connect ${JSON.stringify(first)}`);
  process.nextTick(() => this.destroy(refused()));
  return this;
} as typeof connect;

dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: unknown[]): void {
  note(`udp ${JSON.stringify(args.slice(1, 3))}`);
  const done = args.at(-1);
  if (typeof done === "function") process.nextTick(() => done(refused()));
} as typeof dgram.Socket.prototype.send;

const bunConnect = Bun.connect;
Object.defineProperty(Bun, "connect", {
  value: (o: Parameters<typeof Bun.connect>[0]) => {
    if ("unix" in o) return bunConnect(o);
    note(`bun ${JSON.stringify(o)}`);
    return Promise.reject(refused());
  },
});
