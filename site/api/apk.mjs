// /download/harbor.apk (rewrite in vercel.json): the latest release's Android app, served from
// this domain. A github.com link on a phone can open in the GitHub app or a custom tab, and the
// download then never reaches the installer; a plain same-site download does.
const REPO = "RDevNeo/harbor";
const ASSET = "harbor-android.apk";

async function latest() {
  // GitHub answers the "latest" link with a redirect to the tagged asset: that tag is the version.
  const r = await fetch(`https://github.com/${REPO}/releases/latest/download/${ASSET}`, { redirect: "manual" });
  const to = r.headers.get("location") || "";
  const m = to.match(/\/releases\/download\/v([^/]+)\//);
  if (!m) throw new Error(`no release redirect (${r.status})`);
  const apk = await fetch(`https://github.com/${REPO}/releases/download/v${m[1]}/${ASSET}`);
  if (!apk.ok || !apk.body) throw new Error(`asset ${apk.status}`);
  return { version: m[1], apk };
}

async function serve(head) {
  try {
    const { version, apk } = await latest();
    const h = {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": 'attachment; filename="harbor.apk"',
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
      "X-Harbor-Version": version,
    };
    const len = apk.headers.get("content-length");
    if (len) h["Content-Length"] = len;
    if (head) {
      await apk.body.cancel();
      return new Response(null, { headers: h });
    }
    return new Response(apk.body, { headers: h });
  } catch (e) {
    return new Response(`The Android app can't be fetched right now (${e.message}). Get it from https://github.com/${REPO}/releases/latest\n`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

export function GET() {
  return serve(false);
}

export function HEAD() {
  return serve(true);
}
