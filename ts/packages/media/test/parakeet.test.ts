import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as parakeet from "../src/parakeet.ts";
import { type Sandbox, findModel, installModel, pidAlive, sandbox, until, wavFile } from "./fixture.ts";

describe("the model files", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
  });
  afterEach(async () => {
    await box.restore();
  });

  test("are listed with their sources, sizes and checksums", () => {
    const parts = parakeet.parts();
    expect(parts.map((p) => basename(p.dst))).toEqual(["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt", "silero_vad.onnx"]);
    expect(parts[0]?.url).toBe("https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/encoder.int8.onnx");
    expect(parts[4]?.url).toBe("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx");
    expect(parts.every((p) => p.dst.startsWith(parakeet.dir()))).toBe(true);
    expect(parts[3]?.sha256).toBe("");
    expect(parts.filter((p) => p.sha256 !== "").every((p) => /^[0-9a-f]{64}$/.test(p.sha256))).toBe(true);
    expect(parakeet.size()).toBe(671_122_626);
    expect(parakeet.modelMb()).toBe(671);
    expect(parakeet.dir()).toBe(join(box.data, "harbor", "parakeet", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"));
  });

  test("count as installed only when every file has its size", () => {
    expect(parakeet.installed()).toBe(false);
    mkdirSync(parakeet.dir(), { recursive: true });
    for (const p of parakeet.parts()) {
      writeFileSync(p.dst, "");
      truncateSync(p.dst, p.size);
    }
    expect(parakeet.installed()).toBe(true);
    truncateSync(parakeet.parts()[2]?.dst as string, 10);
    expect(parakeet.installed()).toBe(false);
  });

  test("are not used when missing or when memory is short", async () => {
    await expect(parakeet.transcribe(new Int16Array(16000))).rejects.toThrow("The Parakeet model isn't downloaded.");
    expect(parakeet.loaded()).toBe(false);
    expect(parakeet.workerPid()).toBeNull();
    await parakeet.unload();
    await parakeet.remove();
  });

  test("free memory comes from the system unless a rig forces it", () => {
    process.env.HARBOR_TEST_MEMAVAIL_MB = "1234";
    expect(parakeet.memAvailableMb()).toBe(1234);
    delete process.env.HARBOR_TEST_MEMAVAIL_MB;
    expect(parakeet.memAvailableMb()).toBeGreaterThan(0);
  });

  test("a worker request is read strictly", () => {
    expect(parakeet.parseHead({ op: "parakeet", dir: "/m" })).toEqual({ op: "parakeet", dir: "/m" });
    expect(parakeet.parseHead({ op: "load" })).toEqual({ op: "load", dir: "" });
    expect(parakeet.parseHead({ op: "whisper", dir: "/w", name: "base", lang: "pt" })).toEqual({ op: "whisper", dir: "/w", name: "base", lang: "pt" });
    expect(parakeet.parseHead({ op: "rm -rf" })).toBeNull();
    expect(parakeet.parseHead(null)).toBeNull();
    expect(parakeet.parseHead("load")).toBeNull();
  });

  test("know 25 languages", () => {
    expect(parakeet.LANGS).toHaveLength(25);
    expect(parakeet.LANGS).toContain("pt");
    expect(parakeet.LANGS).not.toContain("ja");
  });
});

const model = findModel();
if (!model) console.warn("SKIPPED speech engine tests: no Parakeet model on this PC (set HARBOR_TEST_PARAKEET_DIR to a folder with its files and test_wavs/en.wav)");

describe.skipIf(!model)("the speech engine", () => {
  let box: Sandbox;
  let src: NonNullable<typeof model>;

  beforeAll(() => {
    src = model as NonNullable<typeof model>;
    box = sandbox();
    installModel(src);
  });
  beforeEach(() => {
    process.env.HARBOR_TEST_MEMAVAIL_MB = "4000";
    parakeet.setKeepMin(5);
  });
  afterEach(async () => {
    box.reset();
    await parakeet.unload();
  });
  afterAll(async () => {
    await parakeet.unload();
    await box.restore();
  });

  test("preloads while someone speaks, then answers at once; two requests at a time wait for each other", async () => {
    expect(parakeet.warmth()).toBe("cold");
    expect(parakeet.preload()).toBe(true);
    expect(parakeet.warmth()).toBe("loading");
    // A second start while it loads doesn't queue another load.
    expect(parakeet.preload()).toBe(false);
    await until(() => parakeet.loaded(), 30_000);
    expect(parakeet.warmth()).toBe("warm");
    expect(parakeet.preload()).toBe(false);
    const pid = parakeet.workerPid() as number;
    const en = wavFile(src, "en");
    const [a, b] = await Promise.all([parakeet.transcribe(en), parakeet.transcribe(en)]);
    expect(a.toLowerCase()).toContain("ask not what your country can do for you");
    expect(b).toBe(a);
    expect(parakeet.workerPid()).toBe(pid);
  }, 60_000);

  test("detects German and Spanish by itself", async () => {
    for (const name of ["de", "es"]) {
      const text = await parakeet.transcribe(wavFile(src, name));
      console.log(`${name}: ${text}`);
      expect(text.length).toBeGreaterThan(10);
    }
  }, 60_000);

  test("does not load with little free memory, but answers when already loaded", async () => {
    process.env.HARBOR_TEST_MEMAVAIL_MB = "100";
    await expect(parakeet.transcribe(wavFile(src, "en"))).rejects.toThrow("Not enough free memory for Parakeet (100 MB free).");
    expect(parakeet.workerPid()).toBeNull();
    process.env.HARBOR_TEST_MEMAVAIL_MB = "4000";
    await parakeet.transcribe(wavFile(src, "en"));
    process.env.HARBOR_TEST_MEMAVAIL_MB = "100";
    expect(await parakeet.transcribe(wavFile(src, "en"))).not.toBe("");
  }, 60_000);

  test("a recording longer than 30 s is cut at its pauses and read in pieces", async () => {
    const en = wavFile(src, "en");
    const gap = new Int16Array(16000 * 1.5);
    const long = new Int16Array((en.length + gap.length) * 9);
    for (let i = 0; i < 9; i++) long.set(en, i * (en.length + gap.length));
    expect(long.length).toBeGreaterThan(16000 * 30);
    const text = await parakeet.transcribe(long);
    const heard = text.toLowerCase().split("ask not what your country can do for you").length - 1;
    console.log(`long: ${heard} of 9 sentences`);
    expect(heard).toBeGreaterThanOrEqual(8);
  }, 120_000);

  test("a worker that dies is replaced by the next request", async () => {
    parakeet.setWorkerCommand(["sh", "-c", "exit 0"]);
    await expect(parakeet.transcribe(wavFile(src, "en"))).rejects.toThrow("The speech engine stopped (out of memory?); try again.");
    expect(parakeet.loaded()).toBe(false);
    expect(parakeet.workerPid()).toBeNull();
    parakeet.setWorkerCommand(null);
    expect(await parakeet.transcribe(wavFile(src, "en"))).not.toBe("");
    const pid = parakeet.workerPid() as number;
    process.kill(pid, "SIGKILL");
    await until(() => !pidAlive(pid));
    expect(await parakeet.transcribe(wavFile(src, "en"))).not.toBe("");
    expect(parakeet.workerPid()).not.toBe(pid);
  }, 120_000);

  test("a worker that hangs is given up on", async () => {
    parakeet.setWorkerCommand(["sh", "-c", "exec sleep 60"]);
    parakeet.setCallTimeout(300);
    const t0 = Date.now();
    await expect(parakeet.transcribe(wavFile(src, "en"))).rejects.toThrow("The speech engine stopped");
    expect(Date.now() - t0).toBeLessThan(5000);
    parakeet.setCallTimeout(600_000);
    expect(parakeet.workerPid()).toBeNull();
  }, 30_000);

  test("the model is freed after each use when it is not kept, and after the idle time otherwise", async () => {
    parakeet.setKeepMin(0);
    await parakeet.transcribe(wavFile(src, "en"));
    expect(parakeet.loaded()).toBe(false);
    expect(parakeet.workerPid()).toBeNull();
    parakeet.setKeepMin(5);
    await parakeet.transcribe(wavFile(src, "en"));
    const pid = parakeet.workerPid() as number;
    expect(parakeet.loaded()).toBe(true);
    expect(await parakeet.reap(Date.now() + 30_000)).toBe(false);
    expect(await parakeet.reap(Date.now() + 5 * 60_000 + 1000)).toBe(true);
    expect(parakeet.loaded()).toBe(false);
    expect(pidAlive(pid)).toBe(false);
    expect(await parakeet.reap()).toBe(false);
    parakeet.setKeepMin(0);
    await parakeet.transcribe(wavFile(src, "en"));
    // Kept less than two minutes: still two, so a model preloaded while someone speaks waits for the recording to end.
    parakeet.setKeepMin(1);
    await parakeet.transcribe(wavFile(src, "en"));
    expect(await parakeet.reap(Date.now() + 90_000)).toBe(false);
    expect(await parakeet.reap(Date.now() + 121_000)).toBe(true);
    parakeet.setKeepMin(5);
  }, 120_000);

  test("removing the model frees it and deletes its files", async () => {
    await parakeet.transcribe(wavFile(src, "en"));
    await parakeet.remove();
    expect(parakeet.loaded()).toBe(false);
    expect(existsSync(parakeet.dir())).toBe(false);
    expect(parakeet.installed()).toBe(false);
    expect(existsSync(join(src.dir, "encoder.int8.onnx"))).toBe(true);
    installModel(src);
  }, 60_000);
});
