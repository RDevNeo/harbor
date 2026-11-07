# Harbor's WhatsApp engine

A linked device of the user's personal WhatsApp account (like WhatsApp Web), through
[Baileys](https://github.com/WhiskeySockets/Baileys). Harbor's WhatsApp host
(`ts/packages/mcp/src/whatsapphost.ts`) runs `engine.mjs` as a process of its own and talks to it
in JSON lines; everything else (what's stored, the tools, pacing) is Harbor's, in `ts/`.

This folder is GPL-3.0-or-later (see `LICENSE`): Baileys' Signal code (`libsignal`) is GPL, so the
engine stays out of Harbor's MIT code and releases. Harbor downloads these files at its build's
commit from GitHub, checks them against `SHA256SUMS` (built into Harbor), and installs the npm
packages from `bun.lock` with its own runtime (`BUN_BE_BUN=1 harbor install --frozen-lockfile
--production --omit peer --ignore-scripts`).

After changing any file here, run `./sums.sh` (Harbor checks the download against it). To change
Baileys' version: edit `package.json`, then `BUN_BE_BUN=1 harbor install --omit peer
--ignore-scripts --lockfile-only` with the installed Harbor (its pinned Bun), then `./sums.sh`.

A rig points `HARBOR_WHATSAPP_ENGINE` at a folder holding these files and their `node_modules`.
