// Carries Harbor's Google OAuth clients (baked into release bundles by Harbor's scripts/build.ts,
// packages/mcp/src/apps.ts BAKED_GOOGLE) from an existing bundle into the next Hub build (packaging/hub-install.sh).
// Usage: node packaging/hub-google.cjs OUT_ENV_FILE BUNDLE...
// Writes HARBOR_GOOGLE_*=value lines (0600) from the first bundle that has them; prints only how
// many it found, never the values. Exit 0 when found, 1 when none had them.
'use strict'
const fs = require('node:fs')

const RE = /\{id:([\w$]+)\("([^"]+)"\),secret:\1\("([^"]+)"\),webId:\1\("([^"]+)"\),webSecret:\1\("([^"]+)"\)\}/
const SAFE = /^[\w.-]{8,200}$/

function extract(text) {
  const m = RE.exec(text)
  if (!m) return null
  const v = { HARBOR_GOOGLE_CLIENT_ID: m[2], HARBOR_GOOGLE_CLIENT_SECRET: m[3], HARBOR_GOOGLE_WEB_CLIENT_ID: m[4], HARBOR_GOOGLE_WEB_CLIENT_SECRET: m[5] }
  return Object.values(v).every((x) => SAFE.test(x)) ? v : null
}

if (require.main === module) {
  const [out, ...bundles] = process.argv.slice(2)
  if (!out) { console.error('usage: engine-google.cjs OUT_ENV_FILE BUNDLE...'); process.exit(2) }
  for (const b of bundles) {
    let text
    try { text = fs.readFileSync(b, 'utf8') } catch { continue }
    const v = extract(text)
    if (!v) continue
    fs.writeFileSync(out, Object.entries(v).map(([k, x]) => `${k}=${x}\n`).join(''), { mode: 0o600 })
    console.log(`google clients: carried over from ${b}`)
    process.exit(0)
  }
  process.exit(1)
}

module.exports = { extract }
