import { describe, expect, test } from "bun:test";
import { MemKv } from "../src/kv.ts";
import {
  profileDetectedText,
  detectProfiles,
  profileFullName,
  profileGatherLocal,
  ghHostsLogins,
  profileRulesMe,
  profileRulesPeer,
  sshKeyComment,
  profileKnownHosts,
  loadProfileDetected,
  mergeProfileProposals,
  profileNameFromUser,
  newProfileDetected,
  newProfileLocalFacts,
  newProfileProposal,
  profileNoreplyLogin,
  profileParseAnswer,
  profileSshHosts,
  PROFILE_KEY,
  PROFILE_PROMPT,
  PROFILE_SYSTEM,
  profileCheck,
  profileCheckJson,
  profileFacts,
  profileInputs,
  ProfileScheduler,
  profileSignature,
  profileScrub,
  type ProfileAccountFacts,
  type ProfileDetectInputs,
  type ProfileEnv,
  type ProfilePcFacts,
} from "../src/profile.ts";

const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIEqhynrPCgtXyZ0123456789abcdef";

describe("profile", () => {
  test("ssh_config_names_only", () => {
    const c = "Host thinkpad ana\n    HostName 2001:db8::7\n    User sam-lee\nHost mac\n  HostName sams-laptop.local\n  User samlee\nHost *\n  User x\n";
    const h = profileSshHosts(c);
    expect(h[0]).toEqual({ alias: "thinkpad", host: "", user: "sam-lee" });
    expect(h[1]?.user).toBe("sam-lee");
    expect(h[2]).toEqual({ alias: "mac", host: "sams-laptop.local", user: "samlee" });
    expect(h.length).toBe(3);
  });

  test("secrets_never_pass", () => {
    expect(sshKeyComment(`ssh-ed25519 ${BLOB} sam@desk`)).toBe("sam@desk");
    expect(sshKeyComment(`command="x" ssh-rsa ${BLOB} laptop key`)).toBe("laptop key");
    expect(sshKeyComment(`ssh-ed25519 ${BLOB}`)).toBeNull();
    expect(sshKeyComment("not a key")).toBeNull();
    const md =
      "Answer in English.\nGITHUB_TOKEN=ghp_abcdefghijklmnop1234\nmy password: hunter2\nuse key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 here\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ1234567890\n";
    const s = profileScrub(md);
    expect(s).toContain("Answer in English.");
    for (const bad of ["ghp_", "hunter2", "sk-ant", "PRIVATE", "b3BlbnNz"]) expect(s).not.toContain(bad);
    expect(profileScrub("mail sam@example.org at ~/work/repo")).toContain("sam@example.org");
    expect(profileScrub("a\nb\n")).toBe("a\nb");
    const k = profileKnownHosts("desk,2001:db8::2 ssh-ed25519 AAAA\n|1|hashed= ssh-rsa AAAA\n[mac.local]:2222 ssh-rsa AAAA\n2001:db8::4 ssh-rsa AAAA\n");
    expect(k).toEqual(["desk", "mac.local"]);
    const answer = JSON.stringify({ pcs: { "pc:a": { owner: `Sam ghp_${BLOB}`, github: "@sam-gh", confidence: "HIGH", why: "git" }, "pc:x": { owner: "Eve" }, "pc:b": { owner: "Alex", github: "not valid!" } } });
    const a = profileParseAnswer(answer, ["pc:a", "pc:b"]);
    expect(a?.get("pc:a")).toEqual({ owner: "Sam", github: "sam-gh", confidence: "high", why: "git" });
    expect([a?.get("pc:b")?.owner, a?.get("pc:b")?.github, a?.has("pc:x")]).toEqual(["Alex", "", false]);
  });

  test("gh_hosts_and_names", () => {
    const y = "github.com:\n    git_protocol: https\n    users:\n        sam-gh:\n            oauth_token: x\n        other:\n    user: sam-gh\n";
    expect(ghHostsLogins(y)).toEqual(["other", "sam-gh"]);
    expect(profileNameFromUser("ana-souza")).toBe("Ana Souza");
    expect(profileNameFromUser("u0_a289")).toBe("");
    expect(profileNameFromUser("root")).toBe("");
    expect(profileNoreplyLogin("123+sam-gh@users.noreply.github.com")).toBe("sam-gh");
    expect(profileNoreplyLogin("sam@example.org")).toBeNull();
  });

  test("rules_for_this_pc_and_peers", () => {
    const l = newProfileLocalFacts({ git_name: "Sam Lee", full_name: "", github_logins: ["samlee"], ssh_hosts: profileSshHosts("Host thinkpad\n User alex-kim\nHost aspire\n User aspire\n") });
    const acc: ProfileAccountFacts[] = [{ label: "", name: "Sam", email: "", default_profile: true }];
    const me = profileRulesMe(l, acc);
    expect([me.owner, me.github, me.confidence]).toEqual(["Sam Lee", "samlee", "high"]);
    expect(me.why).toBe("From git user.name, the default Claude account, the GitHub login signed in here");
    expect(profileRulesPeer("alex-thinkpad", l.ssh_hosts).owner).toBe("Alex Kim");
    expect(profileRulesPeer("home-aspire", l.ssh_hosts)).toEqual(newProfileProposal());
    const rules = new Map([["a", me]]);
    const model = new Map([["a", newProfileProposal({ owner: "Samuel Lee", confidence: "high", why: "w" })]]);
    const m = mergeProfileProposals(model, rules);
    expect([m.get("a")?.owner, m.get("a")?.github]).toEqual(["Samuel Lee", "samlee"]);
  });

  test("the prompt the model gets", () => {
    expect(PROFILE_SYSTEM.endsWith("You have no tools. Answer with JSON only.")).toBe(true);
    expect(PROFILE_PROMPT.startsWith("For every PC in <facts>, propose")).toBe(true);
    expect(PROFILE_PROMPT).toContain('- why: one short line naming the evidence ("git user.name and gh login on this PC").\n\nAnswer with only this JSON: {"pcs": {"<pc id>": {"owner": "", "github": "", "confidence": "low", "why": ""}}}');
    expect(PROFILE_PROMPT.split("\n").length).toBe(12);
  });

  const files: Record<string, string> = {
    "/etc/passwd": "root:x:0:0::/root:/bin/sh\nsam:x:1000:1000:Sam Lee,,,:/home/sam:/bin/sh\n",
    "/h/.config/gh/hosts.yml": "github.com:\n    user: sam-gh\n",
    "/h/.ssh/config": "Host thinkpad\n  User alex-kim\n",
    "/h/.ssh/authorized_keys": `ssh-ed25519 ${BLOB} alex@thinkpad\n`,
    "/h/.ssh/id.pub": `ssh-ed25519 ${BLOB} sam@desk\n`,
    "/h/.ssh/known_hosts": "mac.local ssh-rsa AAAA\n",
    "/h/.claude/CLAUDE.md": "Answer in English.\nGITHUB_TOKEN=ghp_abcdefghijklmnop1234\n",
  };
  const env: ProfileEnv = {
    home: "/h",
    user: "sam",
    hostname: "desk",
    // The made-up files by "/" paths, whatever this system's join writes.
    read: (p) => files[p.replaceAll("\\", "/")] ?? "",
    readDir: (p) => (p.replaceAll("\\", "/") === "/h/.ssh" ? ["config", "id.pub", "authorized_keys"] : []),
    git: (k) => (k === "user.name" ? "Sam Lee" : k === "user.email" ? "7+sam-lee@users.noreply.github.com" : ""),
    githubUser: () => "sam-app",
  };

  test("this PC's facts come from the files", () => {
    expect(profileFullName(env)).toBe("Sam Lee");
    const l = profileGatherLocal(env);
    expect(l).toEqual({
      hostname: "desk",
      os_user: "sam",
      full_name: "Sam Lee",
      git_name: "Sam Lee",
      git_email: "7+sam-lee@users.noreply.github.com",
      github_logins: ["sam-app", "sam-gh"],
      ssh_hosts: [{ alias: "thinkpad", host: "", user: "alex-kim" }],
      authorized_key_comments: ["alex@thinkpad"],
      own_key_comments: ["sam@desk"],
      known_hosts: ["mac.local"],
      claude_md: "Answer in English.",
    });
  });

  const pcs: ProfilePcFacts[] = [
    { id: "pc:me", name: "desk", this_pc: true, reported_owner: "", reported_github: "", detected: false, phones: ["Pixel"], agent_accounts: ["claude"] },
    { id: "pc:thinkpad", name: "alex-thinkpad", this_pc: false, reported_owner: "", reported_github: "", detected: false, phones: [], agent_accounts: [] },
  ];
  const accounts: ProfileAccountFacts[] = [{ label: "claude", name: "Sam", email: "sam@example.org", default_profile: true }];

  test("a detection without a model uses the rules, with one the model wins", async () => {
    const inp: ProfileDetectInputs = { pcs, accounts, ask: null };
    const d = await detectProfiles(inp, "s1", env, 99);
    expect(d.by).toBe("rules");
    expect(d.at).toBe(99);
    expect(d.me.owner).toBe("Sam Lee");
    expect([...d.peers.keys()]).toEqual(["pc:thinkpad"]);
    expect(d.peers.get("pc:thinkpad")?.owner).toBe("Alex Kim");

    let seen = "";
    const ask = {
      model: "claude-haiku-test",
      run: async (system: string, prompt: string) => {
        seen = `${system}\n${prompt}`;
        return 'Sure: {"pcs": {"pc:me": {"owner": "Samuel Lee", "github": "", "confidence": "high", "why": "git"}}}';
      },
    };
    const m = await detectProfiles({ ...inp, ask }, "s2", env, 100);
    expect(m.by).toBe("claude-haiku-test");
    expect([m.me.owner, m.me.github, m.me.confidence, m.me.why]).toEqual(["Samuel Lee", "sam-app", "high", "git"]);
    expect(m.peers.get("pc:thinkpad")?.owner).toBe("Alex Kim");
    expect(seen).toContain("</facts>\n\nFor every PC in <facts>");
    expect(seen).not.toContain("ghp_");

    const failed = await detectProfiles({ ...inp, ask: { model: "x", run: () => Promise.reject(new Error("down")) } }, "s3", env, 1);
    expect(failed.by).toBe("rules");
    const garbage = await detectProfiles({ ...inp, ask: { model: "x", run: async () => "no json" } }, "s4", env, 1);
    expect(garbage.by).toBe("rules");
  });

  test("the facts are pretty JSON with sorted keys", () => {
    const f = profileFacts(newProfileLocalFacts({ hostname: "desk", ssh_hosts: [{ alias: "a", host: "", user: "u" }] }), { pcs: [pcs[0] as ProfilePcFacts], accounts: [] });
    expect(f.startsWith('{\n  "pcs": [\n    {\n      "agent_accounts": [\n        "claude"\n      ],\n      "detected": false,')).toBe(true);
    expect(f).toContain('"ssh_hosts": [\n        {\n          "alias": "a",\n          "user": "u"\n        }\n      ]');
    expect(f).toContain('"known_hosts": []');
    expect(f.endsWith("\n  }\n}")).toBe(true);
  });

  test("the detection is kept in kv owner_suggested", () => {
    const kv = new MemKv();
    expect(loadProfileDetected(kv)).toBeNull();
    const d = newProfileDetected({
      me: newProfileProposal({ owner: "Sam", github: "sam-gh", confidence: "high", why: "git" }),
      peers: new Map([
        ["pc:z", newProfileProposal({ owner: "Z" })],
        ["pc:a", newProfileProposal({ owner: "A" })],
      ]),
      by: "rules",
      at: 5,
      sig: "ab",
    });
    const sch = new ProfileScheduler();
    sch.running = true;
    sch.finish(d, kv);
    expect(sch.running).toBe(false);
    expect(kv.get(PROFILE_KEY)).toBe(
      '{"me":{"owner":"Sam","github":"sam-gh","confidence":"high","why":"git"},"peers":{"pc:a":{"owner":"A","github":"","confidence":"","why":""},"pc:z":{"owner":"Z","github":"","confidence":"","why":""}},"by":"rules","at":5,"sig":"ab"}',
    );
    expect(profileDetectedText(loadProfileDetected(kv) as never)).toBe(kv.get(PROFILE_KEY) as string);
    kv.set(PROFILE_KEY, '{"me":{"owner":"Only"}}');
    expect(loadProfileDetected(kv)?.me).toEqual(newProfileProposal({ owner: "Only" }));
    kv.set(PROFILE_KEY, '{"me":5}');
    expect(loadProfileDetected(kv)).toBeNull();
    kv.set(PROFILE_KEY, "nope");
    expect(loadProfileDetected(kv)).toBeNull();
  });

  test("signature, inputs and the scheduler", () => {
    const sig = profileSignature(pcs, accounts);
    expect(sig).toMatch(/^[0-9a-f]{1,16}$/);
    expect(profileSignature(pcs, accounts)).toBe(sig);
    expect(profileSignature([{ ...(pcs[1] as ProfilePcFacts), reported_owner: "Alex" }, pcs[0] as ProfilePcFacts], accounts)).not.toBe(sig);
    // FNV-1a of the empty string
    expect(profileSignature([], [])).toBe("cbf29ce484222325");

    const inp = profileInputs({
      pcs: [
        { id: "pc:me", name: "desk", me: true, owner: "Shown", github: "", suggested: true, guessed: false, phones: ["Pixel"], accounts: ["claude"] },
        { id: "pc:b", name: "lap", me: false, owner: " Alex ", github: "alex", suggested: true, guessed: false, phones: [], accounts: [] },
        { id: "pc:c", name: "old", me: false, owner: "Guess", github: "g", suggested: true, guessed: true, phones: [], accounts: [] },
      ],
      typedOwner: "",
      typedGithub: "",
      accounts: [
        { id: "claude", installed: true, loggedIn: true, short: "claude", name: "Sam", email: "s@example.org" },
        { id: "claude2", installed: true, loggedIn: false, short: "claude2", name: "", email: "" },
        { id: "codex", installed: false, loggedIn: null, short: "codex", name: "", email: "" },
      ],
      ask: null,
    });
    expect(inp.pcs.map((p) => [p.reported_owner, p.reported_github, p.detected])).toEqual([
      ["", "", false],
      ["Alex", "alex", true],
      ["", "", false],
    ]);
    expect(inp.accounts).toEqual([{ label: "claude", name: "Sam", email: "s@example.org", default_profile: true }]);

    const kv = new MemKv();
    const s = new ProfileScheduler();
    const args = (nowMs: number, full: boolean, confirmed = false) => ({ nowMs, full, kv, confirmed, inputs: () => inp });
    expect(s.tick(args(0, false))).toBeNull();
    expect(s.tick(args(1000, true))).toBeNull();
    expect(s.tick(args(24_000, true))).toBeNull();
    const first = s.tick(args(26_000, true));
    expect(first?.sig).toBe(profileSignature(inp.pcs, inp.accounts));
    expect(s.running).toBe(true);
    expect(s.tick(args(60_000, true))).toBeNull();
    s.finish(newProfileDetected({ sig: first?.sig ?? "" }), kv);
    expect(s.tick(args(70_000, true))).toBeNull();
    s.want = true;
    expect(s.tick(args(71_000, false, true))).not.toBeNull();
    expect(s.want).toBe(false);
    s.finish(newProfileDetected({ sig: "other" }), kv);
    expect(s.tick(args(90_000, true))).not.toBeNull();
    s.finish(newProfileDetected({ sig: first?.sig ?? "" }), kv);
    expect(s.tick(args(95_000, true, true))).toBeNull();
  });

  test("Is this you? asks only about an unconfirmed detection", () => {
    const kv = new MemKv();
    const state = { confirmed: false, owner: "Sam Lee", github: "samlee" };
    expect(profileCheck(kv, state)).toBeNull();
    const d = newProfileDetected({ me: newProfileProposal({ owner: "Sam Lee", why: "From git user.name." }) });
    kv.set(PROFILE_KEY, profileDetectedText(d));
    expect(profileCheck(kv, state)).toEqual({
      key: "Sam Lee|samlee",
      title: "Is this you?",
      body: "Harbor detected Sam Lee · GitHub samlee as this PC's owner. From git user.name. Agents and your other PCs see it.",
    });
    expect(profileCheck(kv, { ...state, github: "" })?.body).toBe("Harbor detected Sam Lee as this PC's owner. From git user.name. Agents and your other PCs see it.");
    expect(profileCheck(kv, { ...state, confirmed: true })).toBeNull();
    expect(profileCheck(kv, { ...state, owner: "" })).toBeNull();
    expect(profileCheckJson(null)).toBeNull();
  });
});

