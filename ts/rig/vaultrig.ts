// The account vault end to end against the real Worker (`wrangler dev --local`) and the fake Clerk
// that worker/test/run.py starts: two PCs of one account (each its own TLS key, Harbor session and
// data folders), the real sources (accountvault.ts: the apps folder, secrets.json) and the
// single-host controller with a stand-in integration. Run by worker/test/vaultrig.py:
//   bun ts/rig/vaultrig.ts <worker url> <clerk url>
// Prints PASS/FAIL lines and exits 1 on a failure.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSource, secretSource, SingleHost, type SingleApp } from "../accountvault.ts";
import { generateIdentity, signWith, spkiOf, Vault, type Identity, type VaultCall } from "../packages/net/src/index.ts";
import { secrets } from "../packages/store/src/index.ts";

const [W = "http://127.0.0.1:47996", CLERK = "http://127.0.0.1:47995"] = process.argv.slice(2);
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, extra = ""): void => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra ? `  [${extra}]` : ""}`);
};
const b64u = (b: Buffer) => b.toString("base64url");
const base = mkdtempSync(join(process.env.HOME ? join(process.env.HOME, ".cache") : tmpdir(), "hvaultrig-"));

async function clerkAccess(email: string): Promise<string> {
  await fetch(`${CLERK}/test/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  const verifier = b64u(randomBytes(32));
  const redir = "http://127.0.0.1:51234/callback";
  const q = new URLSearchParams({ response_type: "code", client_id: "harbor-test-client", redirect_uri: redir, scope: "openid profile email offline_access", code_challenge: b64u(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", state: "s", prompt: "login" });
  const a = await fetch(`${CLERK}/oauth/authorize?${q}`, { redirect: "manual" });
  const code = new URL(a.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const t = await fetch(`${CLERK}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redir, client_id: "harbor-test-client", code_verifier: verifier }) });
  return ((await t.json()) as { access_token: string }).access_token;
}

/** A Harbor session for this PC's key, as AccountService.session makes it. */
async function session(id: Identity, email: string, name: string): Promise<string> {
  const access = await clerkAccess(email);
  const ts = Math.floor(Date.now() / 1000);
  const sig = signWith(id, `harbor-device-v1\n${ts}\n${createHash("sha256").update(access).digest("hex")}`);
  const r = await fetch(`${W}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
    body: JSON.stringify({ device: { kind: "pc", name, spki: Buffer.from(spkiOf(id)).toString("base64"), ts, sig: Buffer.from(sig).toString("base64") }, app: "rig" }),
  });
  const v = (await r.json()) as { token?: string };
  if (!v.token) throw new Error(`no session: ${JSON.stringify(v)}`);
  return v.token;
}

function caller(token: string): VaultCall {
  return async (method, path, body) => {
    const r = await fetch(`${W}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const v: unknown = await r.json();
    if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(v)}`);
    return v;
  };
}

function stand(root: string): SingleApp & { up: boolean } {
  const a = {
    name: "rigapp",
    up: false,
    root: () => root,
    linkedHere: () => existsSync(join(root, "linked.json")),
    accountHere: () => (existsSync(join(root, "linked.json")) ? readFileSync(join(root, "linked.json"), "utf8") : ""),
    sessionFiles: () => ["auth/creds.json", "linked.json"].filter((f) => existsSync(join(root, f))),
    running: async () => a.up,
    stop: async () => void (a.up = false),
    wipe: () => {
      rmSync(join(root, "auth"), { recursive: true, force: true });
      rmSync(join(root, "linked.json"), { force: true });
    },
    request: async (req: Record<string, unknown>) => ({ ran: req.op }),
    ops: ["status", "call"],
    gapMs: 0,
  };
  return a;
}

async function pc(name: string, email: string) {
  const id = generateIdentity();
  const dir = join(base, name);
  const apps = join(dir, "data", "apps");
  const secretsFile = join(dir, "data", "secrets.json");
  const app = stand(join(apps, "rigapp"));
  mkdirSync(app.root(), { recursive: true });
  let single: SingleHost | null = null;
  const vault = new Vault({ stateDir: join(dir, "state"), identity: () => id, sources: () => [fileSource(() => apps), secretSource(secretsFile), ...(single?.sources() ?? [])], log: process.env.RIG_LOG ? (l) => console.log(`  ${name}: ${l}`) : undefined });
  single = new SingleHost({ vault, me: () => ({ id: `ts:${name}`, name }), dest: (pid, fp) => ({ addr: `${pid}:47930`, fp }) }, [app]);
  vault.afterSync.push(() => single?.tick() ?? Promise.resolve());
  vault.beforeLeave.push(() => (single as unknown as { leaving(): Promise<void> }).leaving());
  vault.afterLeave.push(() => (single as unknown as { left(): Promise<void> }).left());
  const token = await session(id, email, name);
  // The account id, as the session's token says.
  const account = (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { sub: string }).sub;
  return { id, name, apps, secretsFile, app, vault, single, token, account, sync: () => vault.sync(account, caller(token)) };
}

async function main(): Promise<void> {
  for (const [email, first] of [["sam@example.com", "Sam"], ["eve@example.com", "Eve"]]) {
    await fetch(`${CLERK}/test/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, first_name: first, last_name: "Rig" }) });
  }
  const desk = await pc("desk", "sam@example.com");
  mkdirSync(join(desk.apps, "gmail.accounts"), { recursive: true });
  mkdirSync(join(desk.apps, "github"), { recursive: true });
  writeFileSync(join(desk.apps, "gmail.accounts", "sam@example.com.json"), JSON.stringify({ access_token: "ya29.rig-access", refresh_token: "1//rig-refresh", account: "sam@example.com" }));
  writeFileSync(join(desk.apps, "github", "hosts.yml"), "github.com:\n    oauth_token: gho_rigtoken\n    user: sam\n");
  secrets.save("OPENAI_KEY", "sk-rig-value", "docs bot", desk.secretsFile);
  mkdirSync(join(desk.app.root(), "auth"), { recursive: true });
  writeFileSync(join(desk.app.root(), "auth", "creds.json"), "linked-device keys v1");
  writeFileSync(join(desk.app.root(), "linked.json"), "Sam (+1 555 0100)");
  desk.app.up = true;
  await desk.sync();
  await desk.sync();
  check("desk: a new vault is open, its key made by the service", desk.vault.status().state === "open");
  check("desk: runs the single-host app", desk.vault.lease("rigapp")?.mine === true);

  // Sam signs in on a new laptop (the desk doesn't run in between).
  const laptop = await pc("laptop", "sam@example.com");
  await laptop.sync();
  check("laptop: open on its first round, nobody else running", laptop.vault.status().state === "open");
  check("laptop: Gmail's sign-in came", readFileSync(join(laptop.apps, "gmail.accounts", "sam@example.com.json"), "utf8").includes("1//rig-refresh"));
  check("laptop: gh's login came", readFileSync(join(laptop.apps, "github", "hosts.yml"), "utf8").includes("gho_rigtoken"));
  check("laptop: the saved key came, with its description", JSON.stringify(secrets.load(laptop.secretsFile)) === JSON.stringify(secrets.load(desk.secretsFile)));
  check("laptop: doesn't run the app, reaches the desk for it", laptop.single?.mayRun("rigapp") === false && existsSync(join(laptop.app.root(), "remote.json")));

  // What the service holds: nothing readable.
  const raw = await (await fetch(`${W}/v1/vault`, { headers: { authorization: `Bearer ${desk.token}` } })).text();
  check("the vault's rows hold ciphertext only", !["ya29", "rig-refresh", "gho_", "sk-rig", "OPENAI", "sam@example.com.json", "linked-device"].some((s) => raw.includes(s)));

  // A token refresh on the laptop and a sign-out of GitHub on the desk.
  writeFileSync(join(laptop.apps, "gmail.accounts", "sam@example.com.json"), JSON.stringify({ access_token: "ya29.refreshed", refresh_token: "1//rig-refresh", account: "sam@example.com" }));
  rmSync(join(desk.apps, "github", "hosts.yml"));
  await laptop.sync();
  await desk.sync();
  await laptop.sync();
  check("a refreshed token reaches the other PC", readFileSync(join(desk.apps, "gmail.accounts", "sam@example.com.json"), "utf8").includes("ya29.refreshed"));
  check("a sign-out of an integration reaches the other PC", !existsSync(join(laptop.apps, "github", "hosts.yml")));

  // Sam signs out of the desk: the session moves to the laptop with its newest keys.
  writeFileSync(join(desk.app.root(), "auth", "creds.json"), "linked-device keys v2");
  await desk.vault.leave();
  check("desk after sign-out: no sign-ins, no keys, no session left", !existsSync(join(desk.apps, "gmail.accounts", "sam@example.com.json")) && secrets.load(desk.secretsFile).length === 0 && !desk.app.linkedHere());
  await laptop.sync();
  check("laptop runs the app now, with the desk's newest keys", laptop.vault.lease("rigapp")?.mine === true && readFileSync(join(laptop.app.root(), "auth", "creds.json"), "utf8") === "linked-device keys v2");

  // A third PC with every other PC off: it needs nothing from them.
  const spare = await pc("spare", "sam@example.com");
  await spare.sync();
  check("spare: everything comes with every other PC off", spare.vault.status().state === "open" && secrets.load(spare.secretsFile)[0]?.value === "sk-rig-value" && readFileSync(join(spare.apps, "gmail.accounts", "sam@example.com.json"), "utf8").includes("ya29.refreshed"));
  check("spare: nothing of the old per-PC key pair", !existsSync(join(base, "spare", "state", "vault-device.json")));

  // Another account's PC sees nothing of Sam's.
  const eve = await pc("eve", "eve@example.com");
  await eve.sync();
  await eve.sync();
  check("another account gets its own, empty vault", eve.vault.status().state === "open" && eve.vault.status().items === 0 && !existsSync(join(eve.apps, "gmail.accounts")));
  await laptop.sync(); // it hears of the spare PC
  check("the laptop's host refuses the other account's PC", (await laptop.single?.serveMesh(eve.id.fp, { app: "rigapp", req: { op: "call" } }))?.status === 403);
  check("the laptop's host answers the account's new PC", (await laptop.single?.serveMesh(spare.id.fp, { app: "rigapp", req: { op: "call" } }))?.status === 200);
}

try {
  await main();
} catch (e) {
  check("rig ran to the end", false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}
const bad = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad === 0 ? 0 : 1);
