# Harbor accounts (Cloudflare Worker)

Harbor's account API. Clerk handles Google sign-in and organizations (= workspaces); this Worker
holds the Clerk secret, keeps invites (its own, accepted inside Harbor; Clerk's need an email-enabled instance), per-account settings and each workspace's PC directory in
D1, and issues Harbor tokens (Ed25519 JWTs) that every PC verifies offline. No build step, no
runtime dependencies.

## Endpoints

Wire format: see "Accounts" in `android/PROTOCOL.md`.

- `GET /v1/keys`: token public keys
- `POST /v1/session`: Clerk access token + device proof -> Harbor token, workspaces
- `GET /v1/directory`: workspaces with members, PCs, devices, invites
- `POST /v1/pcs`, `DELETE /v1/pcs/{fp}`: register / remove a PC
- `DELETE /v1/devices/{fp}`: remove a device
- `GET|PUT /v1/settings`: per-account settings, newest write per key wins
- `PUT|DELETE /v1/me/photo`: the account's photo (a JPEG, PNG or WebP of at most 2 MB, stored as Clerk's profile image), or none (D1 `photo_off`: Google's isn't shown again either); members' photos are `image` in the directory
- `POST /v1/workspaces/{ws}/invites`, `DELETE .../invites/{id}`, `DELETE .../members/{user}`
- `GET /oauth/android`: bounces the OAuth redirect to `harbor://oauth`
- `GET /v1/invites`, `POST /v1/invites/{id}/accept|decline`: the signed-in account's pending invitations
- `GET /invite`: a landing page (unused while invitations aren't emailed)
- `POST /v1/release`: the release workflow's ping. The body is ignored; the worker re-reads GitHub's latest release itself (`src/release.js`)
- `GET /v1/release/wait?have=<version>[&wait=<seconds>]`: held until a release newer than `have` exists (answers `{version}` at once if one already does, `204` after about 50 s so the PC reconnects). No sign-in: phones use it too (`Update.java`), with `wait` (0 to 240): how long to hold instead, 0 = answer at once (`204` when nothing is newer)
- `POST /v1/github`: GitHub's push webhook on the repository (content type JSON, secret `GITHUB_WEBHOOK_SECRET`, checked against `X-Hub-Signature-256`); a push to `main` is told to the PCs below
- `POST /v1/main` (a PC's Harbor token): the PC just pushed main, `{sha}`. Never believed: the Worker reads main from GitHub (`info/refs`, once a second at most, a few tries while GitHub shows another commit) and tells the PCs what GitHub says
- `GET /v1/main/wait?have=<commit>`: held until main's newest commit (as the webhook told it) isn't `have`; answers `{sha, at}`, or `204` after about 50 s. PCs following main (followmain.ts) only take it as a reason to look

## Deploy

Secret values are typed at the prompt (or set in the Cloudflare dashboard), never put in git or chat.

1. `npm ci`
2. `npx wrangler login`
3. `npx wrangler d1 create harbor-accounts`, then paste the printed `database_id` into `wrangler.toml`.
4. `npx wrangler d1 migrations apply harbor-accounts --remote`
5. `npm run keygen`: prints the private key and the `kid:base64url` public key. The public key goes into
   `KEYS` in `src/account.rs` (PCs check phones' tokens with it, offline); without it a build trusts the
   keys `GET /v1/keys` serves over HTTPS.
6. `npx wrangler secret put CLERK_SECRET_KEY` and `npx wrangler secret put HARBOR_SIGNING_KEY` (paste the keygen private key).
   Also `VAULT_SECRET`: 32 random bytes, base64 (`openssl rand -base64 32 | npx wrangler secret put VAULT_SECRET`).
   It seals each account's vault key at rest (`vault_keys`, src/vault.js). If it's ever lost or changed, the
   stored keys stop opening and the account's PCs that hold a key hand it over again on their next round.
   Also `GITHUB_WEBHOOK_SECRET`: the secret of the repository's push webhook (payload URL `{PUBLIC_URL}/v1/github`,
   content type `application/json`, the push event only). Unset, `/v1/github` answers 503 and PCs following main
   fall back to `git ls-remote` every 3 minutes.
7. Edit `[vars]` in `wrangler.toml`: `CLERK_FRONTEND_URL`, `PUBLIC_URL`, and the rest if needed.
8. `npx wrangler deploy`
9. Optional: attach a custom domain to the Worker in the Cloudflare dashboard, and set `PUBLIC_URL` to it.

Then point the apps at it: `CLERK_URL`, `CLIENT_ID` and `ACCOUNTS_URL` in `src/account.rs`, and the same
three defaults in `android/build.sh` (`HARBOR_CLERK_URL`, `HARBOR_CLERK_CLIENT_ID`, `HARBOR_ACCOUNTS_URL`).
Test builds override them with those environment variables.

Local test: `npm test` runs `test/run.py`: `test/fakeclerk.py` (Clerk's OAuth endpoints and the Backend API
subset the Worker uses) and the real Worker under `wrangler dev --local`, driven through every endpoint.

## Clerk dashboard checklist

- User & authentication: Google is the only sign-in method; use RDevNeo's own Google OAuth client for production.
- Organizations: enabled, "Allow users to create organizations" on, maximum members per organization 20.
- OAuth applications: add one public client, PKCE required, scopes `openid profile email offline_access`,
  redirect URIs `http://127.0.0.1/callback` and `{PUBLIC_URL}/oauth/android`; consent screen off if allowed.
  Its client id goes into `HARBOR_CLERK_CLIENT_ID` / the app constant.
- Copy the Frontend API URL into `CLERK_FRONTEND_URL` and the secret key into the Worker secret.

## Free tier notes

- Clerk Hobby: 50k monthly retained users, 100 retained organizations (counted only with 2 or more members),
  20 members per organization, sessions fixed at 7 days, no MFA.
- Cloudflare Workers free: 100k requests per day.
- D1 free: 5M rows read and 100k rows written per day.

## Release news (Durable Object)

`src/release.js` is the `ReleaseHub` class bound as `RELEASES` (`wrangler.toml`, with its migration). One object holds every PC's long-poll
and answers all of them when a newer release is published, which it only believes after reading GitHub (and finding the release's
`harbor-app.json.minisig`, so an older release without the update files is never announced). Nothing here is deployed by the TypeScript
rewrite's branch: `wrangler deploy` is the owner's step. Held requests keep the object awake: a few PCs cost seconds of duration a day;
`MAX_WAITERS` (1000) bounds it.

## Account events (Durable Object)

`src/accounthub.js` is the `AccountHub` class bound as `ACCOUNT_HUB` (`wrangler.toml`, migration `v2-account-hub`). One object per
account (`idFromName(user id)`) tells its devices that something changed, so an invitation or a new member shows at once:

- `GET /v1/events` with `Upgrade: websocket` (PCs): accepted with the hibernation API, so an idle socket costs no duration; the
  client's `"ping"` is answered `"pong"` by the runtime without waking the object. The first message is `{seq, what: "hello"}`.
- `GET /v1/events?since=N` (phones, which have no WebSocket client): a long poll of up to 20 s (`EVENTS_WAIT_MS`) while a screen of
  the app is open; at once when `N` is behind; 204 when nothing changed.
- Pushes (`tell` in `src/index.js`) carry `{seq, what}` only, `what` = `invites` or `directory`: devices re-read the authenticated
  routes. Sent on an invitation made or cancelled (to the invitee's accounts, found by verified address, and the owner), accepted
  or declined (the account, the inviter, the workspace's members), a member removed or leaving, and a PC registered into, moved out
  of or removed from a workspace. Re-registering every few minutes sends nothing.
- Deploy: the migration is part of `npx wrangler deploy` (no D1 change). Clients from before it fall back to polling (PCs: invites
  every minute while the socket is down, the directory every 2 minutes).

## Phone sign-in with Android's own account picker (optional)

Until this is set up, phones sign in in the browser through Clerk. To switch the picker on:

1. Google Cloud console (https://console.cloud.google.com): create (or pick) a project, e.g. "Harbor".
2. APIs & Services › OAuth consent screen (Google Auth Platform › Branding): app name "Harbor", support
   email, External, publish to Production (the scopes are only openid/email/profile: no review needed).
3. Credentials › Create credentials › OAuth client ID › **Web application**, name "Harbor web". No redirect
   URIs are needed for the picker. Copy its client id (`…apps.googleusercontent.com`).
4. Credentials › Create credentials › OAuth client ID › **Android**, package name `dev.harbor.app`, SHA-1
   `4B:E7:4B:5F:50:FD:99:BE:08:1E:C7:F0:CF:99:F4:58:FC:74:B2:B6` (the release key; CI signs with the same).
   It needs no secret and isn't put anywhere: Google Play services checks the app against it.
5. Give the **Web** client id to both sides, never committing it:
   - the Worker: `npx wrangler secret put GOOGLE_WEB_CLIENT_ID` (or Cloudflare dashboard › harbor-accounts ›
     Settings › Variables and Secrets), then `npx wrangler deploy`. Don't also add it to `wrangler.toml`:
     a var with the same name blocks the secret (error 10053);
   - the phone: the GitHub repository **secret** `HARBOR_GOOGLE_WEB_CLIENT_ID` (Settings › Secrets and variables ›
     Actions › Secrets; a variable would be printed in the build log). The release workflow passes it to
     `android/build.sh`; then release.
6. Clerk: nothing has to change. A phone's Google account becomes the Clerk account with the same verified
   email (made by a sign-in through Clerk, e.g. on a PC); a Google account with no Harbor account yet signs
   in through Clerk in the browser once. Optional, for production: in Clerk › SSO connections › Google, turn
   on "Use custom credentials" with this same Web client (add Clerk's redirect URI to it), so Google's
   consent screen says Harbor on desktop too.
