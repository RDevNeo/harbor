import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { parseIp } from "./ip.ts";
import { now, type Kv } from "./kv.ts";
import { F64, Ordered, wire, type Json } from "./wire.ts";

/** kv: the last detection, a ProfileDetected. */
export const PROFILE_KEY = "owner_suggested";
/** Seconds after startup before the first detection. */
const STARTUP_WAIT_MS = 25_000;
/** kv: the suggestion the pop-up was closed for (`owner|github`). */
export const PROFILE_TOAST_KEY = "owner_toast_dismissed";

export const PROFILE_SYSTEM = "You work out who owns which PC of a person's Harbor mesh (Harbor runs AI coding agents and links the owner's PCs and phones) from facts the PCs found about themselves. You have no tools. Answer with JSON only.";

export const PROFILE_PROMPT = "For every PC in <facts>, propose its owner's name (the person who uses it, as they would write it: \"Ana Souza\", not a login) and their GitHub login.\n\nRules:\n- A PC that reports an owner itself (reported_owner, detected false) keeps it.\n- The strongest signals for this_pc: git user.name, the full name, the GitHub logins signed in, the default agent account (default_profile) and its email. Other agent accounts, phones and SSH entries on a PC can belong to other people (a family member, a colleague who shares the PC): only use them for a PC's owner when they point at that PC.\n- A phone named after a person (\"A13 de Ana\", \"Ana's Pixel\") names someone who uses that PC, not necessarily its owner.\n- For another PC: SSH hosts whose alias, host or user matches its name, key comments naming it, and what it reports.\n- Give a GitHub login only with evidence (a signed-in login, a users.noreply.github.com email, a remote or note naming it). Never invent one; use \"\" when unknown. Same for the owner.\n- confidence: \"high\" when two independent signals agree, \"medium\" for one good signal, \"low\" for a guess.\n- why: one short line naming the evidence (\"git user.name and gh login on this PC\").\n\nAnswer with only this JSON: {\"pcs\": {\"<pc id>\": {\"owner\": \"\", \"github\": \"\", \"confidence\": \"low\", \"why\": \"\"}}}";

export interface ProfileProposal {
  owner: string;
  github: string;
  confidence: string;
  why: string;
}

export function newProfileProposal(p: Partial<ProfileProposal> = {}): ProfileProposal {
  return { owner: "", github: "", confidence: "", why: "", ...p };
}

/** A detection: this PC's own profile, its guesses about its peers (by PC id, sorted), and how it was made. */
export interface ProfileDetected {
  me: ProfileProposal;
  peers: Map<string, ProfileProposal>;
  /** "claude-haiku-…" or "rules". */
  by: string;
  at: number;
  /** What it saw (peers, phones, accounts): a change starts the next one. */
  sig: string;
}

export function newProfileDetected(d: Partial<ProfileDetected> = {}): ProfileDetected {
  return { me: newProfileProposal(), peers: new Map(), by: "", at: 0, sig: "", ...d };
}

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function btree<T>(m: Iterable<[string, T]>): Map<string, T> {
  return new Map([...m].sort((a, b) => byteCmp(a[0], b[0])));
}

function proposalJson(p: ProfileProposal): Ordered {
  return new Ordered([
    ["owner", p.owner],
    ["github", p.github],
    ["confidence", p.confidence],
    ["why", p.why],
  ]);
}

/** The detection as kv stores it (serde's field order; peers sorted by id). */
export function profileDetectedText(d: ProfileDetected): string {
  const peers = new Ordered([...btree(d.peers)].map(([id, p]): [string, Json] => [id, proposalJson(p)]));
  return wire(
    new Ordered([
      ["me", proposalJson(d.me)],
      ["peers", peers],
      ["by", d.by],
      ["at", d.at],
      ["sig", d.sig],
    ]),
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function textField(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return v === undefined ? "" : typeof v === "string" ? v : null;
}

function parseProposal(v: unknown): ProfileProposal | null {
  if (v === undefined) return newProfileProposal();
  if (!isObject(v)) return null;
  const owner = textField(v, "owner");
  const github = textField(v, "github");
  const confidence = textField(v, "confidence");
  const why = textField(v, "why");
  return owner === null || github === null || confidence === null || why === null ? null : { owner, github, confidence, why };
}

export function loadProfileDetected(kv: Kv): ProfileDetected | null {
  const t = kv.get(PROFILE_KEY);
  if (t === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const me = parseProposal(v.me);
  if (!me || (v.peers !== undefined && !isObject(v.peers))) return null;
  const peers = new Map<string, ProfileProposal>();
  for (const [id, p] of Object.entries(isObject(v.peers) ? v.peers : {})) {
    const pp = parseProposal(p);
    if (!pp) return null;
    peers.set(id, pp);
  }
  const by = textField(v, "by");
  const sig = textField(v, "sig");
  const at = v.at === undefined ? 0 : typeof v.at === "number" && Number.isInteger(v.at) ? v.at : null;
  if (by === null || sig === null || at === null) return null;
  return { me, peers: btree(peers), by, at, sig };
}

/** Another PC, or this one, as the mesh has it. */
export interface ProfilePcFacts {
  id: string;
  name: string;
  this_pc: boolean;
  /** What it says about itself (empty: nothing, or an old Harbor). */
  reported_owner: string;
  reported_github: string;
  /** Its own report is a detection it hasn't had confirmed. */
  detected: boolean;
  phones: string[];
  agent_accounts: string[];
}

/** An agent account signed in on this PC. */
export interface ProfileAccountFacts {
  label: string;
  name: string;
  email: string;
  /** The PC's default profile (~/.claude): its person's own login. */
  default_profile: boolean;
}

/** Asks the PC's own model; `model` names it in `ProfileDetected.by`. */
export interface ProfileAsk {
  model: string;
  run: (system: string, prompt: string) => Promise<string>;
}

export interface ProfileDetectInputs {
  pcs: ProfilePcFacts[];
  accounts: ProfileAccountFacts[];
  ask: ProfileAsk | null;
}

/** An SSH host entry: alias, host name (never an address) and user. */
export interface ProfileSshHost {
  alias: string;
  host: string;
  user: string;
}

/** This PC's own facts (files and commands). */
export interface ProfileLocalFacts {
  hostname: string;
  os_user: string;
  full_name: string;
  git_name: string;
  git_email: string;
  github_logins: string[];
  ssh_hosts: ProfileSshHost[];
  /** Comments of the keys allowed to log in here (authorized_keys). */
  authorized_key_comments: string[];
  /** Comments of this user's own public keys. */
  own_key_comments: string[];
  /** Host names (not addresses) this user has connected to. */
  known_hosts: string[];
  /** The start of the global CLAUDE.md, scrubbed. */
  claude_md: string;
}

export function newProfileLocalFacts(l: Partial<ProfileLocalFacts> = {}): ProfileLocalFacts {
  return {
    hostname: "",
    os_user: "",
    full_name: "",
    git_name: "",
    git_email: "",
    github_logins: [],
    ssh_hosts: [],
    authorized_key_comments: [],
    own_key_comments: [],
    known_hosts: [],
    claude_md: "",
    ...l,
  };
}

const SECRET_EDGE = "\"'`,;()[]{}<>";
const SECRET_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-", "xox", "AKIA", "eyJ", "AAAA", "glpat-", "npm_"];

function trimChars(s: string, set: string): string {
  const c = [...s];
  let a = 0;
  let b = c.length;
  while (a < b && set.includes(c[a] as string)) a++;
  while (b > a && set.includes(c[b - 1] as string)) b--;
  return c.slice(a, b).join("");
}

/** A word that could be a secret: key material, a token, a long random string. */
function secretWord(word: string): boolean {
  const w = trimChars(word, SECRET_EDGE);
  const len = Buffer.byteLength(w);
  if (len >= 12 && SECRET_PREFIXES.some((p) => w.startsWith(p))) return true;
  // Long runs of base64/hex with digits mixed in (emails, paths and URLs are fine).
  return len >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w);
}

const SECRET_NAMES = ["password", "passwd", "secret", "token", "api_key", "apikey", "private key", "bearer "];

/** Lines that hold a secret go; secret-looking words in the others are blanked. */
export function profileScrub(text: string): string {
  return lines(text)
    .filter((l) => {
      const low = l.toLowerCase();
      const namesSecret = SECRET_NAMES.some((k) => low.includes(k));
      const assigns = l.includes("=") || l.includes(":");
      return !(namesSecret && assigns) && !low.includes("begin ") && !low.includes("private key");
    })
    .map((l) => l.split(" ").map((w) => (secretWord(w) ? "[redacted]" : w)).join(" "))
    .join("\n");
}

/** Rust's str::lines: no empty last line after a final newline. */
function lines(text: string): string[] {
  const v = text.split(/\r?\n/);
  if (v[v.length - 1] === "") v.pop();
  return v;
}

function isAddress(h: string): boolean {
  return parseIp(h) !== null || parseIp(trimChars(h, "[]")) !== null;
}

/** `~/.ssh/config`: each `Host` with its `HostName` (names only) and `User`. */
export function profileSshHosts(text: string): ProfileSshHost[] {
  const out: ProfileSshHost[] = [];
  // The entries the current `Host` line made (none for `Host *` or a `Match` block).
  let group: [number, number] = [0, 0];
  for (const raw of lines(text)) {
    const l = raw.trim();
    const cut = l.search(/[\s=]/);
    const k = (cut < 0 ? l : l.slice(0, cut)).toLowerCase();
    const v = cut < 0 ? "" : l.slice(cut + 1).trim().replace(/^=+/, "").trim();
    if (k === "host") {
      const start = out.length;
      for (const a of v.split(/\s+/).filter((x) => x !== "" && !x.includes("*") && !x.includes("?") && !x.startsWith("!"))) {
        out.push({ alias: a, host: "", user: "" });
      }
      group = [start, out.length];
    } else if (k === "match") {
      group = [out.length, out.length];
    } else if (k === "hostname" && !isAddress(v)) {
      for (const h of out.slice(group[0], group[1])) h.host = v;
    } else if (k === "user") {
      for (const h of out.slice(group[0], group[1])) h.user = v;
    }
  }
  const dedup = out.filter((h, i) => i === 0 || !(h.alias === out[i - 1]?.alias && h.host === out[i - 1]?.host && h.user === out[i - 1]?.user));
  return dedup.slice(0, 40);
}

/** The comment of a public key line (`[options] type blob comment`): never the key itself. */
export function sshKeyComment(line: string): string | null {
  const w = line.split(/\s+/).filter((x) => x !== "");
  const i = w.findIndex((t) => t.startsWith("ssh-") || t.startsWith("ecdsa-") || t.startsWith("sk-ssh") || t.startsWith("sk-ecdsa"));
  if (i < 0 || i + 2 > w.length) return null;
  const c = profileScrub(w.slice(i + 2).join(" "));
  return c.trim() === "" || c.includes("[redacted]") ? null : [...c.trim()].slice(0, 80).join("");
}

/** `known_hosts`: the plain host names (hashed entries and addresses are skipped). */
export function profileKnownHosts(text: string): string[] {
  const v = lines(text)
    .filter((l) => !l.startsWith("|") && !l.startsWith("#"))
    .map((l) => l.split(/\s+/).find((x) => x !== ""))
    .flatMap((h) => (h === undefined ? [] : h.split(",")))
    .map((h) => (h.replace(/^\[+/, "").split("]")[0] ?? ""))
    .filter((h) => h !== "" && !isAddress(h) && h !== "localhost");
  return [...new Set(v.sort(byteCmp))].slice(0, 30);
}

function validGithub(u: string): boolean {
  return u !== "" && Buffer.byteLength(u) <= 39 && /^[A-Za-z0-9-]+$/.test(u) && !u.startsWith("-");
}

/** The logins in a gh `hosts.yml` (`user:` lines and the `users:` map's keys). */
export function ghHostsLogins(text: string): string[] {
  const v: string[] = [];
  let inUsers = false;
  for (const l of lines(text)) {
    const t = l.trim();
    if (t.startsWith("user:")) v.push(t.slice(5).trim());
    if (t === "users:") {
      inUsers = true;
      continue;
    }
    if (inUsers) {
      const indent = l.length - l.trimStart().length;
      if (indent >= 8 && t.endsWith(":")) v.push(t.replace(/:+$/, ""));
      else if (indent <= 4) inUsers = false;
    }
  }
  return [...new Set(v.filter(validGithub).sort(byteCmp))];
}

/** What a PC's files and commands are read through; injected so tests need no real home. */
export interface ProfileEnv {
  home: string;
  user: string;
  hostname: string;
  /** The file's text, "" when unreadable. */
  read(path: string): string;
  /** The names in a folder, [] when unreadable. */
  readDir(path: string): string[];
  /** `git config --global <key>`, "" when unset. */
  git(key: string): string;
  /** Harbor's own GitHub sign-in (the apps), if any. */
  githubUser(): string | null;
}

export function profileNodeEnv(githubUser: () => string | null = () => null): ProfileEnv {
  const hostRead = (p: string): string => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const host = hostRead("/etc/hostname").trim();
  return {
    home: process.env.HOME ?? "",
    user: process.env.USER ?? "",
    hostname: host !== "" ? host : osHostname() || "this PC",
    read: hostRead,
    readDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    git: (key) => {
      try {
        return execFileSync("git", ["config", "--global", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return "";
      }
    },
    githubUser,
  };
}

/** The user's full name from the password database (GECOS). */
export function profileFullName(env: Pick<ProfileEnv, "user" | "read">): string {
  for (const l of lines(env.read("/etc/passwd"))) {
    const f = l.split(":");
    if (f.length > 4 && f[0] === env.user) return (f[4] ?? "").split(",")[0]?.trim() ?? "";
  }
  return "";
}

/** This PC's own facts. */
export function profileGatherLocal(env: ProfileEnv): ProfileLocalFacts {
  const ssh = join(env.home, ".ssh");
  const logins = ghHostsLogins(env.read(join(env.home, ".config/gh/hosts.yml")));
  const gh = env.githubUser();
  if (gh !== null) logins.push(gh);
  const github_logins = [...new Set(logins.sort(byteCmp))];
  const comments = (t: string): string[] => {
    const v = lines(t).map(sshKeyComment).filter((c): c is string => c !== null);
    return [...new Set(v.sort(byteCmp))].slice(0, 30);
  };
  const own = env.readDir(ssh).filter((n) => n.endsWith(".pub")).map((n) => env.read(join(ssh, n))).join("\n");
  return {
    hostname: env.hostname,
    os_user: env.user,
    full_name: profileFullName(env),
    git_name: env.git("user.name"),
    git_email: env.git("user.email"),
    github_logins,
    ssh_hosts: profileSshHosts(env.read(join(ssh, "config"))),
    authorized_key_comments: comments(env.read(join(ssh, "authorized_keys"))),
    own_key_comments: comments(own),
    known_hosts: profileKnownHosts(env.read(join(ssh, "known_hosts"))),
    claude_md: [...profileScrub(env.read(join(env.home, ".claude", "CLAUDE.md")))].slice(0, 3000).join(""),
  };
}

const GENERIC_USERS = ["root", "user", "admin", "ubuntu", "pi", "debian", "arch", "guest", "git", "dev", "omarchy", "android"];

/** "ana-souza" to "Ana Souza"; logins that don't read as a name give "". */
export function profileNameFromUser(u: string): string {
  const parts = u.split(/[-_.]/).filter((p) => p !== "");
  if (parts.length === 0 || /[0-9]/.test(u) || parts.some((p) => GENERIC_USERS.includes(p.toLowerCase()))) return "";
  return parts
    .map((p) => {
      const [f, ...rest] = [...p];
      return f === undefined ? "" : f.toUpperCase() + rest.join("");
    })
    .join(" ");
}

/** The login in a GitHub noreply email (`123+login@users.noreply.github.com`). */
export function profileNoreplyLogin(email: string): string | null {
  const suffix = "@users.noreply.github.com";
  if (!email.endsWith(suffix)) return null;
  const local = email.slice(0, -suffix.length);
  const l = local.slice(local.lastIndexOf("+") + 1);
  return validGithub(l) ? l : null;
}

function confidenceOf(n: number): string {
  return n === 0 ? "" : n === 1 ? "medium" : "high";
}

function firstWordEq(a: string, b: string): boolean {
  const f = (s: string) => (s.split(/\s+/).find((x) => x !== "") ?? "").toLowerCase();
  return f(a) !== "" && f(a) === f(b);
}

/** This PC's profile without a model: names from git, GECOS and the default account; the login from gh, Harbor's sign-in or a noreply email. */
export function profileRulesMe(l: ProfileLocalFacts, accounts: readonly ProfileAccountFacts[]): ProfileProposal {
  const dn = accounts.find((a) => a.default_profile)?.name ?? "";
  const defaultName = dn !== "" && !dn.startsWith("Claude") ? dn : "";
  const names: [string, string][] = [
    [l.git_name, "git user.name"],
    [l.full_name, "the account's full name"],
    [defaultName, "the default Claude account"],
  ];
  const owner = names.find(([n]) => n.trim() !== "")?.[0].trim() ?? "";
  const why = names.filter(([n]) => owner !== "" && firstWordEq(n, owner)).map(([, w]) => w);
  let gh = "";
  const first = l.github_logins[0];
  const noreply = profileNoreplyLogin(l.git_email);
  if (first !== undefined) {
    gh = first;
    why.push("the GitHub login signed in here");
  } else if (noreply !== null) {
    gh = noreply;
    why.push("git's GitHub noreply email");
  }
  return { owner, github: gh, confidence: confidenceOf(Math.min(why.length, 2)), why: why.length === 0 ? "" : `From ${why.join(", ")}` };
}

const NOISE = ["omarchy", "desktop", "laptop", "mesh", "home", "local", "work"];

/** A peer's profile without a model: the user of an SSH host whose alias or name matches the PC's name ("ana-thinkpad" and `Host thinkpad / User ana-souza`). */
export function profileRulesPeer(pc: string, hosts: readonly ProfileSshHost[]): ProfileProposal {
  const pcLow = pc.toLowerCase();
  const tokens = pcLow.split(/[-_.]/).filter((t) => Buffer.byteLength(t) >= 4 && !NOISE.includes(t));
  const hit = (s0: string): boolean => {
    const s = s0.toLowerCase();
    return s !== "" && tokens.some((t) => s.includes(t) || (Buffer.byteLength(s) >= 4 && t.includes(s)));
  };
  for (const h of hosts) {
    const hostFirst = h.host.split(".")[0] ?? "";
    if (!(hit(h.alias) || hit(hostFirst) || h.host.toLowerCase().startsWith(pcLow))) continue;
    const owner = profileNameFromUser(h.user);
    // A user named like the PC ("aspire") is the machine, not a person.
    if (owner === "" || tokens.some((t) => h.user.toLowerCase() === t)) continue;
    return { owner, github: "", confidence: "low", why: `The SSH user on '${h.alias}' in this PC's ssh config` };
  }
  return newProfileProposal();
}

/** Every PC's profile without a model. */
export function profileRules(l: ProfileLocalFacts, inp: Pick<ProfileDetectInputs, "pcs" | "accounts">): Map<string, ProfileProposal> {
  return btree(inp.pcs.map((p): [string, ProfileProposal] => [p.id, p.this_pc ? profileRulesMe(l, inp.accounts) : profileRulesPeer(p.name, l.ssh_hosts)]));
}

function prettyJson(v: Json, ind: string): string {
  const inner = `${ind}  `;
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[\n${v.map((x) => inner + prettyJson(x, inner)).join(",\n")}\n${ind}]`;
  if (v !== null && typeof v === "object" && !(v instanceof Ordered) && !(v instanceof F64)) {
    const o = v as Record<string, Json>;
    const keys = Object.keys(o).sort(byteCmp);
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${prettyJson(o[k] as Json, inner)}`).join(",\n")}\n${ind}}`;
  }
  return wire(v);
}

function pcFactsJson(p: ProfilePcFacts): Json {
  return { ...p };
}

function localJson(l: ProfileLocalFacts): Json {
  return {
    ...l,
    ssh_hosts: l.ssh_hosts.map((h) => ({ alias: h.alias, ...(h.host !== "" ? { host: h.host } : {}), ...(h.user !== "" ? { user: h.user } : {}) })),
  };
}

/** The facts as the model reads them, pretty-printed (nothing secret: scrubbed names and comments). */
export function profileFacts(l: ProfileLocalFacts, inp: Pick<ProfileDetectInputs, "pcs" | "accounts">): string {
  return prettyJson({ pcs: inp.pcs.map(pcFactsJson), this_pc: { facts: localJson(l), agent_accounts: inp.accounts.map((a) => ({ ...a })) } }, "");
}

function cleanField(s: string, max: number): string {
  return [...profileScrub(s).replaceAll("[redacted]", "")]
    .filter((c) => !/\p{Cc}/u.test(c))
    .slice(0, max)
    .join("")
    .trim();
}

/** The model's answer: `{pcs: {id: ProfileProposal}}` (or the map alone), for known PCs only, cleaned. */
export function profileParseAnswer(text: string, ids: readonly string[]): Map<string, ProfileProposal> | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  let v: unknown;
  try {
    v = JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const map = "pcs" in v ? v.pcs : v;
  if (!isObject(map)) return null;
  const out = new Map<string, ProfileProposal>();
  for (const [id, p] of Object.entries(map)) {
    if (!ids.includes(id)) continue;
    const s = (k: string): string => (isObject(p) && typeof p[k] === "string" ? (p[k] as string) : "");
    const gh = s("github").trim().replace(/^@+/, "");
    const conf = s("confidence").toLowerCase();
    out.set(id, {
      owner: cleanField(s("owner"), 80),
      github: validGithub(gh) ? gh : "",
      confidence: ["high", "medium", "low"].includes(conf) ? conf : "low",
      why: cleanField(s("why"), 200),
    });
  }
  return btree(out);
}

/** The model's answer where it has one, the rules' where it left a field empty. */
export function mergeProfileProposals(model: ReadonlyMap<string, ProfileProposal>, rules: ReadonlyMap<string, ProfileProposal>): Map<string, ProfileProposal> {
  const out = new Map(rules);
  const both = (a: string, b: string): string => (a === "" ? b : a);
  for (const [id, m] of model) {
    const r = out.get(id) ?? newProfileProposal();
    out.set(id, {
      owner: both(m.owner, r.owner),
      github: both(m.github, r.github),
      confidence: m.owner === "" ? r.confidence : m.confidence,
      why: both(m.why, r.why),
    });
  }
  return btree(out);
}

/** One detection: the facts, the rules, then the model when there's one (a failing model leaves the rules). */
export async function detectProfiles(inp: ProfileDetectInputs, sig: string, env: ProfileEnv, at: number = now()): Promise<ProfileDetected> {
  const l = profileGatherLocal(env);
  const rules = profileRules(l, inp);
  const ids = inp.pcs.map((p) => p.id);
  let all = rules;
  let by = "rules";
  if (inp.ask) {
    const prompt = `<facts>\n${profileFacts(l, inp)}\n</facts>\n\n${PROFILE_PROMPT}`;
    const answer = await inp.ask.run(PROFILE_SYSTEM, prompt).then(
      (t) => profileParseAnswer(t, ids),
      () => null,
    );
    if (answer) {
      all = mergeProfileProposals(answer, rules);
      by = inp.ask.model;
    }
  }
  const meId = inp.pcs.find((p) => p.this_pc)?.id ?? "";
  const d = newProfileDetected({ by, at, sig });
  for (const [id, p] of all) {
    if (id === meId) d.me = p;
    else if (p.owner !== "" || p.github !== "") d.peers.set(id, p);
  }
  return d;
}

/** What the app needs from a PC of the mesh (meshctx's Pc fits). */
export interface ProfileMeshPc {
  id: string;
  name: string;
  me: boolean;
  owner: string;
  github: string;
  suggested: boolean;
  guessed: boolean;
  phones: string[];
  accounts: string[];
}

/** An agent account of this PC. */
export interface ProfileAccountSource {
  id: string;
  installed: boolean;
  /** null: not known. */
  loggedIn: boolean | null;
  short: string;
  name: string;
  email: string;
}

/** What a detection starts from; `ask` is the PC's own Claude login when it is signed in and not at its limit (and HARBOR_PROFILE_RULES is unset). */
export function profileInputs(a: { pcs: readonly ProfileMeshPc[]; typedOwner: string; typedGithub: string; accounts: readonly ProfileAccountSource[]; ask: ProfileAsk | null }): ProfileDetectInputs {
  const pcs = a.pcs.map((p): ProfilePcFacts => ({
    id: p.id,
    name: p.name,
    this_pc: p.me,
    // This PC's own report is what was typed (the detection is what's being made).
    reported_owner: (p.me ? a.typedOwner : p.guessed ? "" : p.owner).trim(),
    reported_github: p.me ? a.typedGithub : p.guessed ? "" : p.github,
    detected: !p.me && p.suggested && !p.guessed,
    phones: p.phones,
    agent_accounts: p.accounts,
  }));
  const accounts = a.accounts
    .filter((x) => x.installed && x.loggedIn !== false)
    .map((x): ProfileAccountFacts => ({ label: x.short, name: x.name, email: x.email, default_profile: x.id === "claude" }));
  return { pcs, accounts, ask: a.ask };
}

/** What a detection depends on: a change (a peer or phone paired) starts another one. */
export function profileSignature(pcs: readonly ProfilePcFacts[], accounts: readonly ProfileAccountFacts[]): string {
  const parts = pcs.map((p) => `${p.id}:${p.reported_owner === ""}:${p.phones.join("+")}`);
  parts.push(...accounts.map((a) => a.email));
  parts.sort(byteCmp);
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(parts.join("|"))) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16);
}

/** Decides when a detection runs (profile_tick): at startup while unconfirmed, after a peer or phone paired while something is unknown, or when asked. */
export class ProfileScheduler {
  started = false;
  running = false;
  /** "Detect again" (desktop or phone): run at the next tick. */
  want = false;
  private born: number | null = null;

  /** `full` (every 10 s): also checks whether one is due. The returned detection is to be run and given to `finish`. */
  tick(a: { nowMs: number; full: boolean; kv: Kv; confirmed: boolean; inputs: () => ProfileDetectInputs }): { inputs: ProfileDetectInputs; sig: string } | null {
    if (this.running || !(a.full || this.want)) return null;
    // Peers link in the first seconds: one detection after that, not one before and after.
    this.born ??= a.nowMs;
    if (!this.want && a.nowMs - this.born < STARTUP_WAIT_MS) return null;
    const inputs = a.inputs();
    const sig = profileSignature(inputs.pcs, inputs.accounts);
    const last = loadProfileDetected(a.kv);
    const unconfirmed = !a.confirmed;
    const peerUnknown = inputs.pcs.some((p) => !p.this_pc && p.reported_owner === "");
    const due = this.want || (!this.started && unconfirmed) || ((unconfirmed || peerUnknown) && (last === null || last.sig !== sig));
    this.started = true;
    if (!due) return null;
    this.want = false;
    this.running = true;
    return { inputs, sig };
  }

  /** A finished detection is saved. */
  finish(d: ProfileDetected, kv: Kv): void {
    this.running = false;
    kv.set(PROFILE_KEY, profileDetectedText(d));
  }
}

export interface ProfileCheckInfo {
  key: string;
  title: string;
  body: string;
}

/** The unconfirmed profile to ask about (pop-up and the phone's banner). Null once confirmed or with nothing detected. */
export function profileCheck(kv: Kv, cur: { confirmed: boolean; owner: string; github: string }): ProfileCheckInfo | null {
  if (cur.confirmed) return null;
  const d = loadProfileDetected(kv);
  if (!d || cur.owner === "") return null;
  const { owner, github: gh } = cur;
  const who = gh === "" ? owner : `${owner} · GitHub ${gh}`;
  const why = d.me.why === "" ? "" : ` ${d.me.why.replace(/\.+$/, "")}.`;
  return { key: `${owner}|${gh}`, title: "Is this you?", body: `Harbor detected ${who} as this PC's owner.${why} Agents and your other PCs see it.` };
}

export function profileCheckJson(c: ProfileCheckInfo | null): Json {
  return c === null ? null : { key: c.key, title: c.title, body: c.body };
}
