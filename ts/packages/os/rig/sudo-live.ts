// Harbor's passwordless sudo, through the real code (packages/os/src/admin.ts, sudo.ts), for sudo-live.sh. Run as the
// test user: `bun sudo-live.ts status | on [desktop|terminal] | off [desktop|terminal] | auto VERSION`.
import * as admin from "../src/admin.ts";

const [what = "status", arg] = process.argv.slice(2);
const opts = { exe: "/usr/local/bin/harbor", login: false, arg: "--background" };
if (what === "status") console.log((await admin.status()).join("\n"));
else if (what === "on" || what === "off") console.log(JSON.stringify(await admin.set(what === "on", opts, arg === "desktop" ? "desktop" : "terminal")));
else if (what === "auto") console.log(JSON.stringify(await admin.autoSetup({ ...opts, version: arg ?? "0.188.0" }, opts.exe, (note) => console.log(`note: ${note}`))));
else if (what === "state") {
  await admin.refresh();
  console.log(JSON.stringify(admin.state()));
}
