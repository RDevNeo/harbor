# @harbor/mcp: progress

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
