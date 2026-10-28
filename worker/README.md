# Harbor accounts (Cloudflare Worker)

Harbor's account API. Clerk handles Google sign-in and organizations (= workspaces); this Worker
holds the Clerk secret, keeps invites, per-account settings and each workspace's PC directory in
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
- `POST /v1/workspaces/{ws}/invites`, `DELETE .../invites/{id}`, `DELETE .../members/{user}`
- `GET /oauth/android`: bounces the OAuth redirect to `harbor://oauth`
- `GET /invite`: landing page for invitation emails

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
