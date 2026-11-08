// A hub with made-up data for the phone app's screenshots (scripts/boat/phoneshot, on a boat.dev
// sandbox): `bun rig/phonehub.ts DIR PORT TOKEN` seeds DIR (projects, chats with every kind of
// card, a lead with its team) and serves the phone API on 127.0.0.1:PORT, taking TOKEN, until
// killed. Prints "phonehub ready <port>" and a JSON line of the chats' gids once it listens.
// A Discord captcha waits in one chat (gid CAPTCHA_GID, `--screen chat:<it>`) at hCaptcha's
// challenge stage: a made-up picture drawn here, answered by this file in front of the hub (the
// hub itself runs on PORT+1; everything else goes through to it as it is).
// Nothing here is anyone's real data, and it never reaches the network: no mesh, discovery,
// account, updates or webhooks, and no agent turn starts (none is asked for).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const [dir, portArg, token] = process.argv.slice(2);
if (dir === undefined || portArg === undefined || token === undefined) {
  console.error("usage: bun rig/phonehub.ts DIR PORT TOKEN");
  process.exit(2);
}
const port = Number(portArg);
Object.assign(process.env, {
  HOME: join(dir, "home"),
  XDG_DATA_HOME: join(dir, "data"),
  XDG_STATE_HOME: join(dir, "state"),
  XDG_CACHE_HOME: join(dir, "cache"),
  XDG_CONFIG_HOME: join(dir, "config"),
  XDG_RUNTIME_DIR: join(dir, "run"),
  HARBOR_SOCK: join(dir, "run", "harbor.sock"),
  HARBOR_LISTEN: "127.0.0.1",
  HARBOR_NO_DISCOVERY: "1",
  HARBOR_TEST_NO_SIGNIN: "1",
  // The PC's name as the phone shows it: a made-up one, not the machine's.
  HARBOR_MESH_ID: "pc:rig-pc",
  HARBOR_MESH_NAME: "rig-pc",
  // WhatsApp with no WhatsApp: unlinked, and Link / Get a code show a made-up QR and code.
  HARBOR_FAKE_WHATSAPP: "rig",
  // The workspace's other PCs' accounts in the account pickers (meshaccounts.ts): the Laptop on, with its owner's
  // OpenCode; a Tower that is off, with Codex.
  HARBOR_FAKE_PEERS: "pc:laptop=Laptop:9000@Dana_Reyes+opencode,pc:tower=Tower:4000@Dario_Reis+codex!off",
});
for (const d of ["home", "run", "state", "data", "cache", "config"]) mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
// OpenCode as its installer puts it (~/.opencode/bin), so the Account sheet lists it: a stub that only lists models.
mkdirSync(join(dir, "home", ".opencode", "bin"), { recursive: true });
writeFileSync(join(dir, "home", ".opencode", "bin", "opencode"), '#!/bin/sh\n[ "$1" = models ] && printf "nvidia/z-ai/glm-5.3-flash\\nopencode/big-pickle\\nopenrouter/qwen/qwen3-coder\\n"\nexit 0\n', { mode: 0o755 });

// Imported after the environment is set: the store reads its folders when loaded.
const { blankChat, dataDir, Store } = await import("../packages/store/src/index.ts");
type Item = import("../packages/store/src/index.ts").Item;
const { startHub } = await import("../hub.ts");

const home = join(dir, "home");
const project = (name: string, origin: string | null): string => {
  const p = join(home, "code", name);
  mkdirSync(p, { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", p, ...a], { stdout: "ignore", stderr: "ignore" });
  git("init", "-q", "-b", "main");
  if (origin !== null) git("remote", "add", "origin", origin);
  writeFileSync(join(p, "README.md"), `# ${name}\n`);
  git("add", "-A");
  git("-c", "user.name=Sam Rivera", "-c", "user.email=sam@example.com", "commit", "-qm", "First commit");
  return p;
};

// A picture for the image cards: a small made-up chart.
const shot = join(home, "Pictures", "checkout-before-after.png");
mkdirSync(join(home, "Pictures"), { recursive: true });
const bars = [42, 66, 51, 88, 73, 95].map((h, i) => `<rect x="${40 + i * 90}" y="${300 - h * 2.5}" width="60" height="${h * 2.5}" rx="8" fill="${i % 2 ? "#7c6cf2" : "#4fb3a9"}"/>`).join("");
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340"><rect width="600" height="340" fill="#f6f4ef"/>${bars}<text x="40" y="330" font-family="sans-serif" font-size="18" fill="#555">Checkout conversion, last 6 weeks</text></svg>`)).png().toFile(shot);

const t0 = Math.floor(Date.now() / 1000);
const ago = (m: number) => t0 - m * 60;
const user = (text: string, at: number, files: string[] = []): Item => ({ kind: "user", text, files, at, mentions: [], sender: "", intent: "" });
const say = (text: string, at: number): Item => ({ kind: "text", text, at });
const tool = (name: string, summary: string, input: unknown, result: string | null, is_error = false): Item => ({ kind: "tool", id: `t${Math.random().toString(36).slice(2, 10)}`, name, summary, input: JSON.stringify(input), result, is_error });
const done = (at: number, cost = 0.42): Item => ({ kind: "result", cost_usd: cost, duration_ms: 48_200, turns: 6, input_tokens: 41_200, output_tokens: 1_830, cached: 36_000, at, account: "claude", model: "claude-opus-5-5" });
const notice = (icon: string, text: string, detail = ""): Item => ({ kind: "notice", icon, text, detail });

const seed = Store.open(dataDir());
// The hub behind this file's own listener on PORT (the captcha's frames are answered there).
const inner = port + 1;
seed.set("api_port", String(inner));
seed.set("api_enabled", "1");
seed.set("api_tokens", JSON.stringify([{ token, name: "Rig phone", created: t0, group: "", fp: "" }]));
seed.set("onboarded", "1");
// Signed in to a made-up account with two workspaces (Move to workspace…, the drawer's filter); the team's has the
// Laptop and the Tower, whose accounts the pickers offer (HARBOR_FAKE_PEERS below).
const pcs = (id: string) => [{ fp: "", id, name: id.slice(3) }];
// The team's people: Sam and Dana with made-up photos (Rig.java draws them), Dario with none, so his accounts show initials.
const team = [
  { id: "user_rig", name: "Sam Rivera", email: "sam@example.com", role: "member", image: "https://photos.example/sam" },
  { id: "user_dana", name: "Dana Reyes", email: "dana@example.com", role: "owner", image: "https://photos.example/dana" },
  { id: "user_dario", name: "Dario Reis", email: "dario@example.com", role: "member" },
];
seed.set("account", JSON.stringify({ id: "user_rig", email: "sam@example.com", name: "Sam Rivera", workspaces: [{ id: "org_sam", name: "Sam's workspace", role: "owner", personal: true }, { id: "org_team", name: "Team workspace", role: "member" }] }));
seed.set("account_ws", "org_sam");
seed.set("account_dir", JSON.stringify({ at: t0 * 1000, workspaces: [{ id: "org_sam", name: "Sam's workspace", role: "owner", personal: true, pcs: pcs("pc:rig-pc") }, { id: "org_team", name: "Team workspace", role: "member", members: team, pcs: [{ fp: "fp-laptop", id: "pc:laptop", name: "Laptop" }, { fp: "fp-tower", id: "pc:tower", name: "Tower" }] }] }));

const web = seed.addRepo(project("acme-web", "https://github.com/example/acme-web.git"));
const api = seed.addRepo(project("acme-api", "https://github.com/example/acme-api.git"));
const notes = seed.addRepo(project("field-notes", null));
seed.setRepoWorkspace(notes, "org_team");
// Share with workspace…: acme-api is owned by Sam's workspace and shared with Team (the rows' link mark).
seed.setRepoShares(api, ["org_team"]);
// A trusted patch in acme-api with buttons that open a page (agents/src/patches.ts): its chats show them over the composer.
const patchSrc = 'export default { actions: [{ title: "Staging", url: "https://staging.example.com" }, { title: "Run tests", run: "bun test" }, { title: "Grafana", url: "https://grafana.example.com/d/api" }] };\n';
mkdirSync(join(home, "code", "acme-api", ".harbor", "patches"), { recursive: true });
writeFileSync(join(home, "code", "acme-api", ".harbor", "patches", "links.ts"), patchSrc);
seed.set("patch_trust", JSON.stringify({ [new Bun.CryptoHasher("sha256").update(patchSrc).digest("hex")]: t0 }));
// Another PC's acme-web, its folder there: the row names that PC (projectplace.ts, Place.java).
seed.setProjectPc(seed.addRepo("/home/someone/projects/acme-web"), "pc:studio");

const chat = (over: Partial<import("../packages/store/src/index.ts").Chat>, items: Item[]) => {
  const c = seed.createChat(blankChat({ model: "claude-opus-5-5", effort: "medium", started: true, sessionId: crypto.randomUUID(), ...over }));
  seed.saveItems(c.id, items);
  c.updated = over.updated ?? t0;
  seed.saveChat(c);
  return c;
};

// The chat with every card kind (a plain chat shows its tool calls; a lead hides them).
const cards = chat({ repoId: web, title: "Speed up the checkout page", updated: ago(3) }, [
  user("The checkout page takes 4 s to show the total. Can you find out why and fix it? Here's the funnel from last week:", ago(40), [shot, join(home, "code", "acme-web", "README.md")]),
  { kind: "thinking", text: "The total waits on three requests in a row; they could run together." },
  tool("Read", "src/checkout/Total.tsx", { file_path: "src/checkout/Total.tsx" }, "export function Total() {\n  const cart = useCart();\n  const tax = useTax(cart);\n  const ship = useShipping(cart, tax);\n  …"),
  tool("Bash", "npm run bench -- checkout", { command: "npm run bench -- checkout" }, "checkout: first total 4.1 s (3 requests in series)"),
  tool("Edit", "src/checkout/Total.tsx", { file_path: "src/checkout/Total.tsx", old_string: "const tax = useTax(cart);", new_string: "const [tax, ship] = useParallel(cart);" }, "The file has been updated."),
  tool("Bash", "npm test -- checkout", { command: "npm test -- checkout" }, "FAIL src/checkout/Total.test.tsx\n  ✕ shows the total once shipping is known", true),
  say(
    "The total waited on **three requests in a row**: the cart, then tax, then shipping. They don't depend on each other, so they now run together.\n\n" +
      "| Step | Before | After |\n|---|---|---|\n| First total | 4.1 s | 1.3 s |\n| Requests | 3 in series | 3 at once |\n\n" +
      "```ts\nconst [tax, ship] = await Promise.all([taxFor(cart), shippingFor(cart)]);\n```\n\n" +
      "One test still expected the old order; I updated it. Next:\n\n1. Cache the tax table for an hour\n2. Show a placeholder while shipping loads",
    ago(30),
  ),
  done(ago(30)),
  user("Nice. Ship it behind the `fast_total` flag.", ago(12)),
  tool("Bash", "git commit -am 'Checkout: tax and shipping in parallel'", { command: "git commit -am 'Checkout: tax and shipping in parallel'" }, "[main 4f2a9c1] Checkout: tax and shipping in parallel"),
  say("Committed as `4f2a9c1` and put behind `fast_total` (off by default).", ago(10)),
  done(ago(10), 0.18),
  // A message of a mention alone (its note is what the user wrote).
  { kind: "user", text: "", files: [], at: ago(8), mentions: [{ item: 10, from: "Claude", at: ago(10), text: "put behind `fast_total` (off by default)", len: 40, excerpt: true, note: "Turn it on for 10% of users first.", kind: "", chat: "", title: "" }], sender: "", intent: "" },
  // An excerpt with a note that wraps, then the message's own text (the bubble holds all three).
  { kind: "user", text: "Can you show me how it looks?", files: [], at: ago(7), mentions: [{ item: 10, from: "Claude", at: ago(10), text: "Committed as `4f2a9c1` and put behind `fast_total` (off by default).", len: 70, excerpt: true, note: "It shouldn't be off for everyone: staff accounts should get the fast total right away.", kind: "", chat: "", title: "" }], sender: "", intent: "" },
  notice("process", "dev server", "http://127.0.0.1:5173"),
  notice("clock", "Wakes up at 9:00 to check the error rate"),
  notice("wake", "Woke up: the error rate is back under 1%", "Checked the dashboard at 9:00."),
  { kind: "message", from: "reviewer", to: "this chat", text: "Looks good; one nit on the flag name." },
  { kind: "error", text: "The usage limit was reached; the next turn starts at 14:00." },
]);

// A lead with its team (its own transcript shows the user's words and its answers).
const lead = chat({ repoId: api, title: "Rate limits for the public API", role: "lead", name: "lead", updated: ago(1) }, [
  user("Add per-key rate limits to the public API, with a dashboard page showing who hits them.", ago(55)),
  tool("mcp__harbor__spawn_agent", "", { name: "limits", title: "Rate limiter", task: "Token bucket per API key." }, "Spawned 'limits'."),
  tool("mcp__harbor__spawn_agent", "", { name: "dash", title: "Dashboard page", task: "A page listing keys near their limit." }, "Spawned 'dash'."),
  say("Two agents are on it: **limits** writes the token bucket, **dash** the dashboard page. I'll check both before merging.", ago(54)),
  done(ago(54), 0.07),
  notice("report", "limits reported", "**Done**: token bucket per key, 100 requests a minute, 429 with `Retry-After`."),
  say("The limiter is in and tested. The dashboard is still being built.", ago(2)),
  done(ago(2), 0.05),
]);
chat({ repoId: api, title: "Rate limiter", role: "sub", parent: lead.id, name: "limits", updated: ago(8) }, [
  user("Token bucket per API key.", ago(54)),
  say("Done: 100 requests a minute per key, `429` with `Retry-After`.", ago(8)),
  done(ago(8), 0.21),
]);
const dash = chat({ repoId: api, title: "Dashboard page", role: "sub", parent: lead.id, name: "dash", updated: ago(1) }, [user("A page listing keys near their limit.", ago(54))]);
seed.setMainChat(api, lead.id);

const linked = chat({ repoId: web, title: "Move images to the CDN", updated: ago(90) }, [
  user("Serve product images from the CDN.", ago(100)),
  say("Done: images now load from the CDN with a 1-day cache.", ago(90)),
  done(ago(90), 0.31),
]);
// Chat links in a reply (chatlink.ts): a sub-agent's, a markdown link, and one this hub doesn't have.
seed.saveItems(lead.id, [
  ...seed.items(lead.id),
  user("Where are the agents' chats?", ago(1)),
  say(`The dashboard is in harbor://chat/${dash.gid}?pc=rig, and the CDN work is in [the images chat](harbor://chat/${linked.gid}?pc=rig). The old one, harbor://chat/0b5e1c2a-0000-4000-8000-000000000000?pc=rig, is gone.`, ago(1)),
]);
chat({ repoId: web, title: "Fork: CDN cache headers", updated: ago(80) }, [
  notice("fork", "Forked", `harbor:chat/${linked.id}/1`),
  notice("chat", "Move images to the CDN", `harbor:gid/${linked.gid}`),
  user("Use a week-long cache for images that have a hash in their name.", ago(82)),
  say("Hashed names now get `Cache-Control: max-age=604800, immutable`.", ago(80)),
  done(ago(80), 0.09),
]);
chat({ repoId: notes, title: "Summarize the interview notes", updated: ago(60 * 26) }, [
  user("Summarize the five interviews in notes/ by theme.", ago(60 * 27)),
  say("## Themes\n\n- **Onboarding** is the top complaint (4 of 5).\n- **Pricing** is clear to everyone.\n- **Export** is missing for two of them.", ago(60 * 26)),
  done(ago(60 * 26), 0.12),
]);
const cat = chat({ repoId: null, title: "What's a good name for a cat?", updated: ago(60 * 50) }, [
  user("What's a good name for a grey cat?", ago(60 * 50)),
  say("Ash, Pebble, Smoke or Earl Grey.", ago(60 * 50)),
  done(ago(60 * 50), 0.01),
]);
seed.setChatShares(cat.id, ["org_team"]);
// Settled leads: the sidebar's folded Settled section (its header, and its rows once unfolded).
chat({ repoId: web, title: "Old: try the new font", role: "lead", name: "lead", settled: true, updated: ago(60 * 24 * 6) }, [user("Try the new font on the landing page.", ago(60 * 24 * 6))]);
chat({ repoId: notes, title: "Tidy the interview folder", role: "lead", name: "lead", settled: true, updated: ago(60 * 24 * 9) }, [user("Rename the interview files by date.", ago(60 * 24 * 9))]);
// An agent's Discord join waiting on a captcha (the phone's captcha card).
const CAPTCHA_GID = "c4e7a1b2-0000-4000-8000-00000000ca71";
const GUILD = "Example Server";
chat({ gid: CAPTCHA_GID, repoId: notes, title: "Join the Example Server community", updated: ago(0) }, [
  user(`Join ${GUILD} on Discord and say hi in #introductions.`, ago(3)),
  tool("mcp__discord__discord_join", GUILD, { invite: "example" }, "Discord wants a captcha before joining: waiting for a person to solve it."),
  notice("captcha", `Discord needs a captcha to join ${GUILD}`, JSON.stringify({ captcha: "c1", state: "pending", guild: GUILD })),
]);
// Two unsent images, for composer-thumbnail taps, swiping in its viewer and removing a tile.
const COMPOSER_GID = "c4e7a1b2-0000-4000-8000-00000000c071";
const composer = chat({ gid: COMPOSER_GID, repoId: web, title: "Compare the checkout images", updated: ago(5) }, []);
const uploadDir = join(dataDir(), "uploads", "rig-composer");
mkdirSync(uploadDir, { recursive: true });
const composerFiles = [];
for (const [name, tint] of [["before.png", "#4fb3a9"], ["after.png", "#7c6cf2"]] as const) {
  const path = join(uploadDir, name);
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="${tint}"/><text x="90" y="270" font-family="sans-serif" font-size="70" fill="white">${name.slice(0, -4)} image</text></svg>`)).png().toFile(path);
  composerFiles.push({ id: `rig-composer/${name}`, name, path });
}
// A chat whose turn is done but that something will wake (Waiting): a process it started that
// reports its exit (a sleep this file starts and stops) and a wake-up it asked for.
const WAITING_GID = "c4e7a1b2-0000-4000-8000-00000000a171";
const waiting = chat({ gid: WAITING_GID, repoId: api, role: "lead", name: "lead", title: "Deploy the rate limiter to staging", updated: ago(2) }, [
  user("Deploy the rate limiter to staging and tell me when it's live.", ago(4)),
  tool("mcp__harbor__start_process", "deploy", { name: "deploy", command: "./scripts/deploy staging" }, "Started 'deploy'. It keeps running after your turn ends."),
  tool("mcp__harbor__snooze", "", { minutes: 45, reason: "check the staging error rate" }, "Snoozed. End your turn now; you will get a [wake] message."),
  say("The staging deploy is running. I'll report when it finishes, and look at the error rate again in 45 minutes.", ago(2)),
  done(ago(2), 0.18),
]);
const deploy = Bun.spawn(["sleep", "86400"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const { procStart } = await import("../packages/agents/src/procfs.ts");
const deployLog = join(dir, "state", "deploy.log");
writeFileSync(deployLog, "Deploying acme-api to staging…\n");
seed.addProc({ lead: waiting.id, repoId: api, owner: waiting.id, name: "deploy", cmd: "./scripts/deploy staging", cwd: join(home, "code", "acme-api"), pid: deploy.pid, startTicks: procStart(deploy.pid) ?? 0, log: deployLog, url: null });
seed.addTimer(waiting.id, t0 + 45 * 60, "check the staging error rate");
// acme-api's main chat: the drawer's project row shows its status.
seed.setMainChat(api, waiting.id);
// Settings › PCs: the machines each PC added over SSH, under it (GET /v1/hubs `devices`): this PC's Mac
// (as a dictation host would be), and one Laptop (the directory's other PC, Rig.java) told in its hello.
const { newHost, saveRemote } = await import("../packages/net/src/index.ts");
saveRemote(seed, { tailscale: false, user: "", key: "", port: 0, devices: [newHost({ id: "ssh:1", name: "Mac", host: "10.0.0.20", os: "macOS" })] });
seed.set("mesh_peers", JSON.stringify({ "pc:laptop": { id: "pc:laptop", name: "Laptop", phones: true, fp: "", devices: [{ id: "ssh:1", name: "build-box", os: "linux" }] } }));
seed.set("owner_name", "Mara Lind");
seed.set("shared_drafts", JSON.stringify([[composer.id, { text: "Compare [Image #1] and [Image #2]", files: composerFiles, mentions: [], by: "rig-desktop", label: "Desk", rev: 1 }]]));
seed.close();

// This tree's version: the app compares it with its own.
const version = (JSON.parse(await Bun.file(join(import.meta.dirname, "../package.json")).text()) as { version: string }).version;
const h = await startHub({ version, hookPort: false });

// The captcha's picture: the challenge stage as hCaptcha shows it, at 2x the page (448 x 628 page
// px; the captcha 24 px in from its edges). Made up here: a header with small text, 1 px stripes,
// the letter's tile to drag, the dashed place it fits, Skip.
const CW = 896, CH = 1256;
const stripes = Array.from({ length: (CH - 400) / 2 }, (_, i) => `<rect x="48" y="${330 + i * 2}" width="${CW - 96}" height="1" fill="#e4e8ec"/>`).join("");
const challenge = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
  <rect width="${CW}" height="${CH}" fill="#f4f3ef"/>
  <rect x="48" y="48" width="${CW - 96}" height="${CH - 96}" rx="8" fill="#ffffff" stroke="#d5d9dd" stroke-width="2"/>
  <rect x="48" y="48" width="${CW - 96}" height="240" rx="8" fill="#0f8a83"/>
  <rect x="48" y="200" width="${CW - 96}" height="88" fill="#0f8a83"/>
  <text x="84" y="128" font-family="sans-serif" font-size="30" fill="#ffffff">Drag the letter to the place</text>
  <text x="84" y="170" font-family="sans-serif" font-size="30" fill="#ffffff">where it fits</text>
  <text x="84" y="240" font-family="sans-serif" font-size="22" fill="#cdeeea">Please try again if the picture is unclear.</text>
  ${stripes}
  <rect x="140" y="470" width="200" height="200" rx="18" fill="#d63a3a"/>
  <text x="240" y="618" font-family="sans-serif" font-size="150" font-weight="bold" fill="#ffffff" text-anchor="middle">A</text>
  <rect x="520" y="780" width="210" height="210" rx="18" fill="none" stroke="#3a4651" stroke-width="5" stroke-dasharray="18 12"/>
  <rect x="48" y="${CH - 176}" width="${CW - 96}" height="2" fill="#d5d9dd"/>
  <rect x="${CW - 290}" y="${CH - 150}" width="200" height="74" rx="10" fill="#0f8a83"/>
  <text x="${CW - 190}" y="${CH - 101}" font-family="sans-serif" font-size="30" fill="#ffffff" text-anchor="middle">Skip</text>
</svg>`)).jpeg({ quality: 88 }).toBuffer();
const frames = new Map<number, { data: string; width: number; height: number }>();
const frameAt = async (max: number) => {
  const w = Math.max(1, Math.min(CW, Math.round(max) || CW));
  let f = frames.get(w);
  if (f === undefined) {
    const b = w === CW ? challenge : await sharp(challenge).resize(w).jpeg({ quality: 88 }).toBuffer();
    f = { data: b.toString("base64"), width: w, height: Math.round((CH * w) / CW) };
    frames.set(w, f);
  }
  return f;
};
const captcha = async (b: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (b.action === "input") return { taken: true, solver: null };
  if (b.action !== "frame") return {};
  const f = await frameAt(typeof b.max === "number" ? b.max : CW);
  const head = { captcha: "c1", guild: GUILD, seq: 1, width: f.width, height: f.height, crop: { x: 0, y: 0, width: CW / 2, height: CH / 2 }, rect: { x: 24, y: 24, width: CW / 2 - 48, height: CH / 2 - 48 }, solver: null };
  // Nothing repaints here: a call after frame 1 waits as the PC's would, then says so.
  if (typeof b.after === "number" && b.after >= 1) {
    await Bun.sleep(Math.min(typeof b.wait === "number" ? b.wait : 0, 2000));
    return { ...head, same: true };
  }
  return { ...head, data: f.data };
};

// In front of the hub: the captcha's calls answered here, the rest passed through as they are.
const front = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === `/v1/chats/${CAPTCHA_GID}/captcha`) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "Sign in again." }, { status: 401 });
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json(await captcha(body));
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const headers = new Headers(req.headers);
    headers.delete("host");
    return fetch(`http://127.0.0.1:${inner}${u.pathname}${u.search}`, { method: req.method, headers, body, redirect: "manual", decompress: false } as RequestInit);
  },
});
console.log(`phonehub ready ${port}`);
console.log(JSON.stringify({ cards: cards.gid, lead: lead.gid, linked: linked.gid, captcha: CAPTCHA_GID, composer: COMPOSER_GID, waiting: WAITING_GID }));
const stop = async () => {
  front.stop(true);
  deploy.kill();
  await h.stop();
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await new Promise(() => {});
