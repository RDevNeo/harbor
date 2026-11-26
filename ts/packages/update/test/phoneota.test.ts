import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPinnedRuntime } from "../src/followmain.ts";
import { parsePublicKey, verifyFileSignature, verifyBytes } from "../src/minisign.ts";
import { APK, CODE_ZIP, MANIFEST, PhoneBuilds, codeOf, loadCodeKey, offerCode, phoneShips, publish, served, servedFile, shellOf, signBytes, trustedFor, waitOffer, type Run } from "../src/phoneota.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "phoneota-"));

describe("phoneota", () => {
  test("signatures are minisign's (the desktop's verifier, and so the shell's, takes them)", async () => {
    const k = loadCodeKey(join(tmp(), "k"), true);
    if (k === null) throw new Error("no key");
    const data = new TextEncoder().encode("hub code");
    const sig = await verifyBytes(await parsePublicKey(k.pub), data, signBytes(k, data, trustedFor("0.194.0+abc1234", CODE_ZIP)));
    expect(sig.trustedComment).toBe("hub v0.194.0+abc1234 harbor-phone-code.zip");
    // the same key again from its file
    expect(loadCodeKey(join(tmp(), "none"))).toBeNull();
  });

  test("what changes the phone's app", () => {
    expect(phoneShips("android/src/dev/harbor/app/Chat.java")).toBe(true);
    expect(phoneShips("android/shell/shell.lock")).toBe(true);
    expect(phoneShips("assets/fonts/lucide.ttf")).toBe(true);
    expect(phoneShips("android/test/BootTest.java")).toBe(false);
    expect(phoneShips("android/README.md")).toBe(false);
    expect(phoneShips("ts/packages/ui/src/shell.ts")).toBe(false);
    expect(shellOf("# x\nversion=6\ninputs=ab\n")).toBe(6);
    expect(codeOf(1795651848.7)).toBe(1795651848);
    expect(hubPinnedRuntime('LIB=x\nRUNTIME=0.189.0\nRUNTIME_ASSET=y\n')).toBe("0.189.0");
    expect(hubPinnedRuntime("nothing")).toBeNull();
  });

  test("publish serves the files signed, the manifest last; a waiting phone hears it", async () => {
    const lib = tmp();
    const k = loadCodeKey(join(tmp(), "k"), true);
    if (k === null) throw new Error("no key");
    const zip = join(tmp(), "code.zip");
    writeFileSync(zip, "zip bytes");
    const apk = join(tmp(), "a.apk");
    writeFileSync(apk, "apk bytes");
    expect(await waitOffer(lib, 0, 0)).toBeNull();
    const waiting = waitOffer(lib, 0, 5_000);
    const m = { release: "0.194.0+abc1234", commit: "a".repeat(40), at: 1, apk: { code: 1795000000, release: "0.194.0+abc1234", shell: 6 }, phone: { code: 1795000000, release: "0.194.0+abc1234", minShell: 6 } };
    await publish(lib, k, m, { [CODE_ZIP]: zip, [APK]: apk });
    expect((await waiting)?.phone.code).toBe(1795000000);
    expect(await waitOffer(lib, 1795000000, 0)).toBeNull();
    expect(offerCode(served(lib))).toBe(1795000000);
    const pk = await parsePublicKey(k.pub);
    const f = servedFile(lib, CODE_ZIP) as string;
    const sig = await verifyFileSignature(pk, f, readFileSync(`${f}.minisig`, "utf8"));
    expect(sig.trustedComment).toBe("hub v0.194.0+abc1234 harbor-phone-code.zip");
    const man = servedFile(lib, MANIFEST) as string;
    await verifyFileSignature(pk, man, readFileSync(`${man}.minisig`, "utf8"));
    expect(servedFile(lib, "../VERSION")).toBeNull();
    expect(readFileSync(join(lib, "harbor-android.version"), "utf8")).toBe("1795000000");
  });

  test("a commit that changes the phone's app builds it; one that doesn't, nothing", async () => {
    const lib = tmp();
    const home = tmp();
    const keyFile = join(tmp(), "k");
    loadCodeKey(keyFile, true);
    const calls: string[][] = [];
    const diff: Record<string, string> = { "b..c": "ts/packages/ui/src/x.ts", "b..d": "android/src/dev/harbor/app/Chat.java" };
    let built = 0;
    const run: Run = async (cmd) => {
      calls.push(cmd);
      const a = cmd.slice(3);
      if (a[0] === "log") return { code: 0, out: "1795000100" };
      if (a[0] === "show" && a[1]?.endsWith("package.json")) return { code: 0, out: '{"version":"0.194.0"}' };
      if (a[0] === "show") return { code: 0, out: "version=6\n" };
      if (a[0] === "diff") return { code: 0, out: diff[`${a[2]?.[0]}..${a[3]?.[0]}`] ?? "" };
      return { code: 0, out: "" };
    };
    const pb = new PhoneBuilds({
      installDir: lib,
      home,
      run,
      log: () => {},
      keyFile,
      keystore: null,
      apksigner: null,
      build: async (_wt, out) => {
        built++;
        writeFileSync(join(out, "hub-phone-code.zip"), `code ${built}`);
        return true;
      },
    });
    // first: nothing served yet, so it builds
    const tip1 = `b${"1".repeat(39)}`;
    pb.seen(join(home, "src-none"), tip1);
    await pb.idle();
    expect(built).toBe(1);
    expect(served(lib)?.release).toBe(`0.194.0+${tip1.slice(0, 7)}`);
    expect(served(lib)?.phone).toEqual({ code: 1795000100, release: `0.194.0+${tip1.slice(0, 7)}`, minShell: 6 });
    // a desktop-only commit: nothing
    pb.seen("src", `c${"2".repeat(39)}`);
    await pb.idle();
    expect(built).toBe(1);
    // a phone commit: built
    pb.seen("src", `d${"3".repeat(39)}`);
    await pb.idle();
    expect(built).toBe(2);
    expect(calls.some((c) => c.includes("worktree"))).toBe(true);
  });

  test("a build the Hub before this one started is waited for and taken, not made again", async () => {
    const lib = tmp();
    const home = tmp();
    const keyFile = join(tmp(), "k");
    loadCodeKey(keyFile, true);
    const tip = `e${"4".repeat(39)}`;
    mkdirSync(join(home, "phone", "out"), { recursive: true });
    writeFileSync(join(home, "phone", "building.json"), JSON.stringify({ pid: 999999, tip }));
    writeFileSync(join(home, "phone", "out", "exit"), "0\n");
    writeFileSync(join(home, "phone", "out", "hub-phone-code.zip"), "zip");
    const run: Run = async (cmd) => {
      const a = cmd.slice(3);
      if (a[0] === "log") return { code: 0, out: "1795000200" };
      if (a[0] === "show" && a[1]?.endsWith("package.json")) return { code: 0, out: '{"version":"0.194.0"}' };
      if (a[0] === "show") return { code: 0, out: "version=6\n" };
      return { code: 0, out: "" };
    };
    let built = 0;
    let asked = 0;
    const pb = new PhoneBuilds({ installDir: lib, home, run, log: () => {}, keyFile, keystore: null, apksigner: null, alive: () => ++asked < 2, build: async () => (built++, true) });
    pb.seen("src", tip);
    await pb.idle();
    expect(built).toBe(0);
    expect(served(lib)?.phone.code).toBe(1795000200);
  }, 15_000);
});
