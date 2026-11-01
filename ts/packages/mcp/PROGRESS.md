# @harbor/mcp: progress

| Rust module | Status | Rust tests ported |
| --- | --- | --- |
| control | done | 3 of 3 (+5 new: socket, hooks over HTTP, 429, 413, chunked) |
| mcpshim | done | 2 of 2 (+7 new: stdio protocol, real stdio process, socket retry) |
| mcp | done | 9 of 9 (+9 new: OAuth, device login, refresh, Google code, callback, agent env) |

## control, mcpshim, mcp (src/control.rs, mcpshim.rs, mcp.rs)

- `mcp.rs` is split in `apps.ts` (catalogue, credential files, Google accounts, refresh), `signin.ts` (device, OAuth and
  Google flows, the loopback callback, phone flows), `http.ts` and `mcp.ts` (agent env, Claude and Codex config); `mcp.ts`
  re-exports all of it, so callers import `mcp` only.
- Every function that may touch the network is async (`token`, `freshToken`, `freshTokenFor`, `agentEnv`, `claudeServers`,
  `claudeConfig`, `codexArgs`, `googleSaveCode`, `googlePhoneFinish`). The Rust sync callers (turn start) must await.
- `sign_in(id, ctx)` takes a `changed()` callback instead of an egui context. Credential files keep the Rust layout
  (`<data>/apps/<id>.json`, `<id>.accounts/`), so a Rust PC's sign-ins are read as they are.
- Harbor's built-in Google clients (compile-time `option_env!` in Rust) come from `HARBOR_GOOGLE_CLIENT_ID/SECRET` and
  `HARBOR_GOOGLE_WEB_CLIENT_ID/SECRET` at run time; the release step must set them.
- The Gmail and Discord servers are reached through `integrate()` (`wire.ts`), not by import, so `mcp.ts` has no cycle with them.
- `selfExe()` (the command agents get for `harbor app <name>`) is `HARBOR_EXE`, else the running executable; the cli work decides.
- `which`, `childPath`, `openUrl` (sys.ts) copy providers.rs / git.rs because the agents index was empty; swap for the agents exports.
- `control.ts`: `Incoming` is generic over the net `Api`/`Msg` and the update `Offer` types. The webhook port serves through
  `Bun.serve`; there is no cap of 32 simultaneous connections (Rust's `Conns`), Bun's idle timeout (10 s) stays.
  `serveHook` takes a web `Request`, so the public HTTPS listener (hookcert) shares it.
- `serve.ts` is `harbor app <gmail|discord|discord-host|discord-repair>`; it sets Discord's setup version from `harborVersion()` (`version.ts`, set by the app at startup with `setHarborVersion`).
- `serveHook` follows Rust on bodies: a declared length above 1 MB is cut at 1 MB and answered 202, a chunked body above 1 MB gets 413.
- `mcpshim.ts` is the whole of `harbor mcp`: `run(args)` reads stdin, `bun build` of it is about 17 KB and starts in about 50 ms.
- bun test trap: `expect(promise).rejects` on a promise that is still pending blocks the test forever; await `.then(ok, err)`.

## gmail (src/gmail.rs -> src/gmail.ts)

Done. Rust tests ported: 10 of 10 (`base64url_both_ways`, `builds_a_plain_message`, `builds_html_attachments_and_reply_headers`,
`long_subjects_fold_into_short_words`, `reads_a_gmail_payload`, `html_as_text`, `label_changes`, `replies`,
`accounts_and_their_errors`, `small_things`), plus tests against a local
`Bun.serve` standing in for Gmail: search, messages, threads, attachments, send with reply_all and attachments, the multipart
upload for big messages, drafts, modify, trash, labels, filters, a refused token refreshed once, a sign-in that stays refused,
the stdio MCP server and its end of input.

- Same 15 tool names, schemas and reply texts as the Rust server.
- The Rust code spoke HTTPS through `curl` with the token in a 0600 header file so it never sat on a command line. In
  TypeScript `fetch` carries the token in memory, so there is no header file; the token is never on a command line or in an env var.
- Several tool calls cannot overlap on the "current account" global of the Rust file: here the account is a field of the
  per-call `Mailbox`, so nothing is global. Token refreshes are serialised by a promise chain (Rust: a mutex).
- `Options.api` and `Options.upload` point the module at another server (tests); they default to Gmail's real endpoints. There is no
  environment override, so nothing in a running agent's environment can redirect the token.
- `Options.auth` is the only link to Harbor's sign-in store: `{ accounts(), token(email, force) }`, sync or async. `run()` with no
  argument uses `harborAuth()` (`googleAccounts("gmail")`, `freshTokenFor("gmail", ...)` of `mcp.ts`); `profileEmail(token)` is
  Rust's `gmail::profile_email` for a new sign-in.
- `VERSION` (0.108.0, Cargo's) is what `initialize` reports as `serverInfo.version`; `Options.version` overrides it.
- JSON keys of tool schemas are in insertion order; Rust's `serde_json` printed them sorted. No MCP client depends on it.
- Latin-1 / Windows-1252 bodies are decoded byte for byte, as in Rust (no separate cp1252 table).

## ghapi (src/ghapi.rs -> src/ghapi.ts)

Partial: all of ghapi.rs is ported (list, detail, close, reopen, ready, merge and fix calls, the mesh part of the Issues page,
the 60 second cache) but it runs through injected interfaces, because the modules it leans on belong to packages that are not
written yet. Rust tests ported: 4 of 4 (`project_filter_lists_every_pcs_projects`, `only_github_pages_reach_gh`,
`filters_from_the_query`, `pages_on_the_wire`), plus 13 tests of the calls with fakes and a local `Bun.serve` standing in for a peer PC.

- `GhApi.handle(call): Promise<Reply>` replaces `App::api_github`: the thread that answered later is just an async function.
  `Call` is structurally the `Call` of `@harbor/net` (without the Rust reply channel); its `Reply.body` is `unknown` here, so the
  wiring (`ApiDeps.route`) narrows it.
- `GhDeps` ports to fill in when the owners land: `prs` (prs.rs: fetch, groups, authors, labels, sort labels), `issues`
  (issues.rs: fetch, groups, mine, accounts, notes, owner, merge, other_projects, short_error), `details` (prdetail.rs and
  issuedetail.rs: fetch, `gh`, parse_diff, fetch_on, set_open_on), `mesh` (peers, http, forward, map_new, enabled, me), `host`
  (repos, projects, project_of, agent label, context, agent threads for Merge with… / Fix with…), `blocks` (api.rs markdown
  blocks) and `deviceId` (`deviceId` of `@harbor/net` fits as is). The domain types (`Pr`, `Issue`, filters, `PrFull`…) are defined
  in ghapi.ts as what ghapi reads; the ui package can import them or keep its own if they stay assignable.
- `NOT_PROJECT` (issues.rs) is duplicated here.
- Not covered: the ports themselves (no fake `gh`), they are the work of the ui pages and agents packages.

## workspace, machines, bridge, hookcert (src/{workspace,machines,bridge,hookcert}.rs)

All four are ported and run. Rust tests ported: workspace 3 of 3, machines 2 of 2, bridge 8 of 8 (the shell test lives in
`test/shell.test.ts`, because `shell` moved to `src/shell.ts`), hookcert 4 of 4. Around them: tests of every tool and its error
texts, the machines server against fake peers and against a real loopback peer through `@harbor/net`'s `http`, origin
(initialize, prompts, tools), the http forwarding with a local `Bun.serve`, and for hookcert a full ACME exchange against an
in-process RFC 8555 server that checks every JWS, validates the TLS-ALPN-01 challenge by really handshaking with the listener,
and has the CSR verified by `openssl req -verify`. Tests run in a sandbox (`test/sandbox.ts`: temp HOME and XDG dirs).

Tool names, schemas and reply texts match the Rust ones. Decisions:

- `src/shell.ts` holds what bridge.rs shared with the others: `shell`, `shellCommand`, `token`, `hostname`, `quote`, the output
  tail. `hostname` and `quote` are duplicated from the net package's remote module; swap them when convenient.
- Results are `{ ok, content }` objects, not tuples. `workspace.call`, `machines.serveTool` and `mcp`, `bridge.grant`/`port`/`resume`
  are async.
- Paths are joined like Rust's `Path::join` (no normalizing), so `link/../x` means what the system says.
- The bridge HTTP server is hand-written on `node:net` with `allowHalfOpen`, using `@harbor/net`'s `Reader`/`readHead`/`readChunked`:
  the Rust limits (8 KB lines, 413 before reading a body, 431, 32 MB) and the hang-up handling (an end of input from the agent
  closes the bridge's side at once, cancels the request at the server, no CLOSE_WAIT) are kept, which `node:http` cannot do.
- http MCP servers are forwarded with `fetch` instead of curl (the tokens stay in memory, not in a header file). Fix: when none of
  the three kept headers is present, the Rust code wrote an empty line right after the status and cut the head short.
- `bridge.waits` holds the 60 s / 3600 s request waits (Rust shortened them under `cfg(test)`); tests set them to 2 s / 4 s.
- hookcert: no rcgen/ring here, so X.509 and PKCS#10 are built with a small DER writer over `node:crypto`. Bun's `TLSSocket`
  ignores `SNICallback` for server sockets, so the listener reads the ClientHello itself (`clientHello`) and picks the key
  and certificate before the handshake: the challenge's when the hello offers `acme-tls/1` for its name, else the saved
  certificate, else Harbor's own key. A plain-HTTP first byte still gets 400.
- hookcert is a class (`Hooks`) with the module functions `start/kick/status/publicBase/stop` over one instance. A failed round
  now keeps the last error in "(tried again later, or press Check)"; the Rust code showed only the suffix. The port mapping and the
  clock are options (`mapTo`, `isPublic`, `now`).
- The body-size rule for webhooks is control.ts's `serveHook` (413 above 1 MB by Content-Length); Rust cut the body at 1 MB and
  answered 202. That is the lead's file; noted here because hookcert routes every request through it.
- machines `chatKey` hashes to 52 bits (Rust: 62) so the number stays an exact JS integer.

Wiring left for the app (ports, not stubs; each has a default or a setter):

- `bridge.setSlash({ scan, withArgs })`: the ui package's `slash.ts` functions; until set, origin lists no prompts.
- `machines.setHub({ me, peers, versions, http? })`: `me()` and `peers()` from the mesh, `versions()` = net's `versionsText`;
  `machines.publish(kv, projects, issuedIds(kv))` after settings or project changes; `serveShare`/`serveTool` are for
  `GET /mesh/v1/share` and `POST /mesh/v1/tool`.
- `setHarborVersion(v)` from `src/version.ts` is what the origin and machines servers report as their version.
- `hookcert.start({ kv, tokens, send, wake })`: `tokens` is the live webhooks' token set, `send` is control's hook sink.

Not done: nothing from these four modules is missing. Not tested: a real Let's Encrypt or Pebble run (needs the internet), a real router.

## discord, discordhost, discordfreeze, discordrepair, discordsetup (src/discord*.rs -> src/discord*.ts)

Done. Rust tests ported: 20 of 20 (freeze 3, setup 4, discord 4, repair 2, host 7), plus 49 tests that run the code against fakes:
a fake Electron (`test/fakeelectron.ts`, an executable speaking the shell's JSON-lines protocol on stdin and stdout, told what to do
through a file), a fake `harbor` command (`test/fakeharbor.ts`: `app discord-host`, `app discord-repair`), the repo's
`discord/test/fake-claude.mjs` for repair, and local `Bun.serve` servers for the Electron, shell and Vencord downloads. No test
starts a real Discord, Electron, Claude or touches the real socket or data (every test file has its own XDG_DATA_HOME,
XDG_RUNTIME_DIR and HOME).

What really runs: the MCP stdio server (`discord.run`, same 3 protocol answers, tool list from the installed shell's `tools.json`,
notes, status, screenshots, attachments, files for `discord_send`), the host (`discordhost.run`: lock on `h.lock` through
`flock`, Unix socket, engine start/stop/freeze/thaw/quit policy, pacing, self-test and Vencord rollback, sign-in, sign-out, the
captcha window, session-ended handling, left-over client cleanup), setup (pinned Electron download and unzip, shell fetch checked
against `discord/SHA256SUMS`, Vencord versions, repair's override with the forbidden-text check), freeze (cgroup v2 or SIGSTOP),
and repair (a Claude run with only repair's MCP server, 3 attempts per failure, notices).

- Same tool names, schemas (from `discord/tools.json`) and reply texts. Objects printed by the tools have their keys sorted, as
  `serde_json` printed them.
- Every Rust thread became async code. `Host` is a state object with a `Signal` for the Condvar; Rust's `Mutex` needed no
  replacement because nothing awaits between a check and its change. `Host.tick()` is the clock (Rust's `watch` thread);
  `listen(host)` and `run()` give the lock, socket and exit.
- Ports instead of the packages that do not exist yet: `discordsetup.configure({ selfCommand, version, claude })`. `selfCommand`
  is the command that starts Harbor (`HARBOR_EXE` or the running binary, plus the script when run from source), `version` is
  `update::VERSION` and goes into `serverInfo.version` and the shell's download ref, `claude` is the `providers::discover` choice
  (a logged-in Claude Code: `{ bin, env }`). Wire them when the update and agents packages land. `discord.watch(notify)` takes
  the notification function instead of the `Hub`; `trouble(changed)` replaces the egui context.
- `login(signal, update)` follows the host with an `AbortSignal`; `signOut()` is fire and forget. `Pending` is the one of apps.ts.
- Added to the Rust behaviour for testing: `HARBOR_DISCORD_SHELL_URL` (base URL for the shell download; the files are still checked
  against `SHA256SUMS`) and a `sums` argument to `ensureElectron`. Downloads use `fetch` (redirects, three tries) instead of `curl`;
  the attachment fetch has the same limits as before (https only, Discord's CDN only, the byte cap, 45 s).
- The shell is fetched at `HARBOR_DISCORD_REF`, else `HARBOR_GIT_SHA` (a build can set it), else `v<version>` (Rust took the commit at compile time).
- The shell's `SHA256SUMS` is embedded with a text import of the repo's `discord/SHA256SUMS`, as Rust's `include_str!`.
- Zip reading uses `node:zlib` and the central directory, no dependency.
- The shell is started detached (own session and process group, so the whole tree can be frozen or killed), the engine's pid is
  kept in `engine.pid` and a new host kills what an old one left.
- `discordjson.ts` is this module's own small JSON helper set (the lead's `json.ts` has a different shape); not exported.
- Not covered: running real Electron (the repo's `discord/test/rig.mjs` does that on a desktop); cgroup freezing is tested in its
  parts (cgroup file parsing, reclaim against a fake cgroup folder) and SIGSTOP end to end, not against a real systemd scope.
- Not wired yet: `serve.ts` cases for `discord`, `discord-host` and `discord-repair` (the lead's dispatcher), and
  `mcp.integrate({ discord })`.
