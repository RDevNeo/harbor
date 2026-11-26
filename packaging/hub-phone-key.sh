#!/usr/bin/env bash
# Hub's phone code key (ts/packages/update/src/phoneota.ts): makes it once at ~/.local/share/hub-android/hub-code.key
# (or $HUB_CODE_KEY), 0600, and prints its public line, the one android/shell's Minisign.HUB_PUBKEY must carry.
# Keep a copy of that file somewhere safe: without it, phones need a new shell APK to trust another key.
set -euo pipefail
cd "$(dirname "$0")/../ts"
exec bun -e 'import { ensureCodeKey, codeKeyFile } from "./packages/update/src/phoneota.ts"; console.log(ensureCodeKey()); console.error(`key: ${codeKeyFile()}`);'
