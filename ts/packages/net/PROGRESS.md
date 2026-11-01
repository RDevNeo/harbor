# @harbor/net: progress

Phase 2 (network). Every test runs on loopback with throwaway keys; Rust interop runs only inside
`unshare -Urn` (`rig/mesh.sh`, `rig/phone.sh`) with a temp XDG tree, a synthetic db and a throwaway
identity. Nothing here has talked to the real mesh, relay, account service or Clerk.

## Phase 2 checkboxes

- [x] `identity.pem` loads; fingerprints match the Rust app's. A Rust-made identity.pem gives the same
  fingerprint in both apps, and a TypeScript-made one too (throwaway identities, unshare rig).
- [ ] The unchanged Android app connects to the TypeScript hub and drives a chat. NOT run: there is no
  phone or emulator here. What did run: a test client with its own key and a signed Harbor token over
  pinned TLS 1.2 refused for another device/workspace, then state → new chat → items → send → long-poll
  → rename → delete (`test/phone.test.ts`); and `rig/phone.sh`: one synthetic db served by the Rust hub
  and by the TypeScript hub gives byte-identical `GET /v1/chats/{id}/items` (revisions aside).
  `/v1/state` still differs where providers/agents aren't wired (accounts, models, efforts, access,
  switchable, update banners, voice): those come from other packages.
- [x] A Rust PC and a TypeScript PC see each other's chats, directly and through a relay (`rig/mesh.sh`,
  `RELAY=rust` and `RELAY=ts`): each holds the other's chat with its items, byte for byte.
- [ ] Discovery, port mapping and account sign-in work. Ported and tested against fakes on loopback
  only (UDP discovery between loopback sockets, fake PCP/NAT-PMP/UPnP routers, fake Clerk and account
  service). Not run on a real LAN, router or the real service, by the brief's rules.

## Modules

| Rust module | State | Rust tests ported | Notes |
| --- | --- | --- | --- |
| tls | done | 10/10 | node:tls; a stranger from the internet is cut right after the handshake (node can't fail it inside) |
| api (network side) | done | 22/35 | listener, refusals, limits, auth, long-poll, typing/drafts, inbox, uploads, files by range |
| api (app side) | partial | 6 of the 13 left (blocks, media and items on the wire) | phone.ts: state, items, send, create, rename, delete, stop; card `parts` (usertext), commit pills and check_run not ported |
| mesh | done but legacy | 11/12 | pairing, hello, events, chats, items, call, lease, phones, revoke, upload, workers, relays, hubs; the pre-0.13 Tailscale `enroll` path is not ported (`upgrade_from_tailscale`) |
| relay | done | 1/1 | `harbor nc` CLI itself belongs to the cli item |
| discover | done | 1/1 | |
| portmap | done | 6/6 | |
| account | done | 4/4 | |
| chatlink, versions, notify, profile | done | 2/2, 2/2, 5/5, 4/4 | |
| remote | done | 20/20 | |
| meshctx, movepc, relocate, clone, devices | done | 4/4, 6/6, 4/4, 5/5, 5/5 | ssh, git, tar behind an injected runner; Devices' egui page not ported; JPEG to the clipboard needs a converter passed in |
| view (ui module, ported here) | done | 9/9 | phones and the desktop share it |

Totals: 118 of 126 (api.rs 28 of 35) Rust tests of the package's modules ported (plus view.rs's 9); 276 bun tests pass.

## Decisions

- One port for plain and TLS: the first byte is peeked and the socket is wrapped in a Duplex for
  node:tls (Bun can't put TLSSocket on an unshifted net.Socket).
- JSON on the wire goes through `wire()`: serde_json without `preserve_order` writes every `json!`
  object (and every struct nested in one) with sorted keys; `Ordered` keeps a derived struct's order;
  `F64` keeps "1.0". Device ids use Rust's DefaultHasher (SipHash-1-3, zero keys).
- Markdown blocks use markdown-it 15.0.3 (pinned); bare URLs are linked on spans, not by rewriting
  the markdown.
- A request can carry the key it shows (`Dest.as`), so several PCs can run in one test process.
- `PhoneRoutes` answers 503 "agents aren't available in this build" for send/stop without an agents
  backend; `/v1/state` sends empty provider lists without a providers backend.

## Blockers

None in this package. Wiring the agents and providers into `PhoneRoutes`, and the listener into the
app's start, is the cli/app item's.
