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
