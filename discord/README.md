# Harbor's Discord shell

A separate program from Harbor: a minimal Electron app that runs one Discord web page, hidden, so
Harbor's agents can use the user's own Discord account through tools.

**Licence: GPL-3.0-or-later** (see [LICENSE](LICENSE)), because it loads
[Vencord](https://github.com/Vendicated/Vencord) (GPL-3.0-or-later) and carries code ported from
discord-mcp-bridge, whose README and plugin headers declare the same licence.
Harbor itself stays MIT: its binary doesn't contain or link anything from this folder. Harbor
downloads these files on first use and talks to them as a separate process, over stdin and stdout.
Those are two programs side by side, not one combined work.

**Discord's rules forbid automating personal accounts, and an account can be banned for it.** Harbor
says so before signing in. Vencord's own rules also forbid self-bot plugins, so this isn't one and
isn't meant for Vencord's repository: it runs stock Vencord, unmodified.

| File | What it is |
|---|---|
| `main.js` | Electron main: one offscreen page at 1 fps, no window, tray or UI. A real window opens only for a password, 2FA or a captcha at sign-in. |
| `preload.js` | Loads stock Vencord into the page; on the login page, listens to Discord's own QR socket so Harbor can draw the code. |
| `page/harbor.js` | **All the tools**, as code in the page, plus the self-test and the wait for Discord's reconnect after a freeze. The host only calls `$harbor.call(name, args)`, so the engine can be swapped. |
| `tools.json` | The tools' names and schemas, read without starting anything. |
| `scratch.js` | The low-level tools (eval, click, key, query, findModule). Loaded only in scratch mode: a throwaway logged-out page for repair. A signed-in page has none of them. |
| `SHA256SUMS` | What Harbor checks the download against. Run `sums.sh` after changing a file; a Harbor test fails if you forget. |
| `test/` | A fake Discord and an end-to-end rig (`node test/rig.mjs <harbor> <electron>`), and `try.sh` for trying a branch on a real desktop. Not downloaded. |

Harbor fetches official Electron (pinned by sha256) and Vencord's rolling release from their own
GitHub releases, and these files from this repository at the build's commit, so no build job is
needed. See `src/discordsetup.rs` and `src/discordhost.rs` in Harbor.
