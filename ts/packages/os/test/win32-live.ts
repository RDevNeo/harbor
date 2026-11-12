// Harbor's Windows pieces against a real Windows (the boat VM), one check after another, printing ok/FAIL
// for each and exiting 1 if any failed. Run from a copy of ts/packages/os there, with Bun or Harbor's own exe:
//   set BUN_BE_BUN=1 && harbor.exe packages\os\test\win32-live.ts [--tray-seconds N]
// The tray icon stays up N seconds (default 0) so a screenshot can catch it; a toast is posted either way.
import { autostart, audio, clipboard, notify, tray } from "../src/index.ts";
import { encodePng } from "../src/win32/formats.ts";

/** 2x2: red, green / blue, white. */
const PNG2x2 = encodePng(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]), 2, 2);

const fails: string[] = [];
async function check(name: string, f: () => unknown): Promise<void> {
  try {
    const r = await f();
    console.log(`ok   ${name}${r === undefined ? "" : `: ${String(r)}`}`);
  } catch (e) {
    fails.push(name);
    console.log(`FAIL ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}
const expect = (cond: boolean, why: string): void => {
  if (!cond) throw new Error(why);
};
const ps = (cmd: string): string => {
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", cmd], { stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().trim();
};

await check("clipboard: text in, PowerShell reads it", () => {
  expect(clipboard.available(), "not available");
  const t = clipboard.write([{ mime: "text/plain;charset=utf-8", data: new TextEncoder().encode("harbor ✓ text") }]);
  expect(t !== null, "write refused");
  expect(ps("Get-Clipboard") === "harbor ✓ text", `PowerShell read ${JSON.stringify(ps("Get-Clipboard"))}`);
  expect(clipboard.stillOurs(t as number), "not ours right after writing");
});

await check("clipboard: PowerShell's text read back", () => {
  ps("Set-Clipboard -Value 'from powershell'");
  const types = clipboard.types() ?? [];
  expect(types.includes("text/plain;charset=utf-8"), `types ${types.join(",")}`);
  const got = new TextDecoder().decode(clipboard.read("text/plain;charset=utf-8") ?? new Uint8Array());
  expect(got === "from powershell", `read ${JSON.stringify(got)}`);
});

await check("clipboard: an image, as PNG and as a bitmap other apps read", () => {
  const png = PNG2x2;
  const t = clipboard.write([{ mime: "image/png", data: png }]);
  expect(t !== null, "write refused");
  const size = ps("Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { \"$($i.Width)x$($i.Height)\" } else { 'none' }");
  expect(size === "2x2", `Windows Forms sees ${size}`);
  const back = clipboard.read("image/png");
  expect(back !== null && back.length > 8, "no PNG back");
  return `${back?.length} bytes`;
});

await check("clipboard: a screenshot-style bitmap (no PNG) reads as PNG", () => {
  ps("Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = New-Object Drawing.Bitmap 3,2; $b.SetPixel(0,0,[Drawing.Color]::Red); [Windows.Forms.Clipboard]::SetImage($b)");
  const png = clipboard.read("image/png");
  expect(png !== null && png[1] === 0x50, "no PNG made from the bitmap");
  return `${png?.length} bytes`;
});

await check("clipboard: files from a uri-list are a file drop", () => {
  const f = `${process.env.TEMP}\\harbor-clip-test.txt`;
  ps(`Set-Content -Path '${f}' -Value x`);
  const uri = `file:///${f.replaceAll("\\", "/")}\r\n`;
  expect(clipboard.write([{ mime: "text/uri-list", data: new TextEncoder().encode(uri) }]) !== null, "write refused");
  const files = ps("Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }");
  expect(files.toLowerCase() === f.toLowerCase(), `PowerShell sees ${files}`);
});

await check("start at login: on, seen by the registry, off", () => {
  const exe = "C:\\rig\\harbor.exe";
  autostart.set(true, exe, "--background");
  expect(autostart.enabled("--background", exe), "not enabled after set(true)");
  const v = ps("(Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run).Harbor");
  expect(v === `"${exe}" --background`, `Run value ${v}`);
  autostart.set(false, exe, "--background");
  expect(!autostart.enabled("--background", exe), "still enabled after set(false)");
  return autostart.entryPath();
});

await check("notifications: a toast posts and is taken back", async () => {
  expect(notify.available(), "not available");
  notify.post({ id: "harbor-live-1", title: "Harbor test", body: "A toast from win32-live.ts", sound: false, onClick: () => console.log("     (clicked)") });
  await Bun.sleep(1500);
  const shown = ps(
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('dev.harbor.Harbor') | Measure-Object).Count",
  );
  notify.remove("harbor-live-1");
  await Bun.sleep(500);
  const after = ps(
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('dev.harbor.Harbor') | Measure-Object).Count",
  );
  return `in Action Center: ${shown}, after remove: ${after}`;
});

const traySeconds = Number(process.argv[process.argv.indexOf("--tray-seconds") + 1] ?? 0) || 0;
await check("tray: the icon goes up and comes down", async () => {
  expect(tray.available(), "not available");
  const png = PNG2x2;
  const stop = tray.start({ iconPng: png, iconPoints: 16, colorPng: png, tooltip: "Harbor test", items: [{ label: "Open Harbor", onClick: () => console.log("     (open)") }, "separator", { label: "Quit", onClick: () => {} }] });
  expect(stop !== null, "no icon");
  if (traySeconds > 0) {
    console.log(`     icon up for ${traySeconds} s`);
    await Bun.sleep(traySeconds * 1000);
  }
  stop?.();
});

await check("microphone: record-mic gives samples or says why not", async () => {
  expect(audio.available(), "not available");
  // Harbor's exe records with `harbor record-mic`; under Bun, the same through this package directly.
  const index = new URL("../src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const self = process.execPath.toLowerCase().endsWith("harbor.exe")
    ? [process.execPath]
    : [process.execPath, "-e", `const { audio } = await import(${JSON.stringify(index)}); process.exit(await audio.recordToStdout());`];
  const r = audio.recorder(self);
  expect(r !== null, "no recorder");
  const p = Bun.spawn([r?.bin ?? "", ...(r?.args ?? [])], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_BE_BUN: undefined } });
  await Bun.sleep(1500);
  p.kill();
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  const err = (await new Response(p.stderr).text()).trim();
  expect(out.length > 0 || err.includes("microphone"), `no samples and no reason (${err})`);
  return out.length > 0 ? `${out.length} bytes in 1.5 s` : err;
});

console.log(fails.length === 0 ? "all ok" : `${fails.length} failed: ${fails.join("; ")}`);
process.exit(fails.length === 0 ? 0 : 1);
