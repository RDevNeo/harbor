import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as voice from "../src/voice.ts";
import { Fail, Recording, RATE, clean, insertSpaced, outputWithin, rms, wav, wavSamples } from "../src/voice.ts";
import { type Sandbox, fakeRecorder, sandbox, tmp, until } from "./fixture.ts";

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(async () => {
  await box.restore();
});

test("inserts_with_spaces", () => {
  expect(insertSpaced("", 0, " hello ")).toEqual(["hello", 5]);
  expect(insertSpaced("fix it", 6, "now")).toEqual(["fix it now", 10]);
  expect(insertSpaced("fix it", 3, "all")).toEqual(["fix all it", 7]);
  expect(insertSpaced("ação é", 4, "olá")).toEqual(["ação olá é", 8]);
});

test("cleans_whisper_output", () => {
  expect(clean(" Hello there.\n And then.\n")).toBe("Hello there. And then.");
  expect(clean("[BLANK_AUDIO]\n")).toBe("");
  expect(clean("[00:00:00.000 --> 00:00:02.000]   Olá mundo\n(music)\n")).toBe("Olá mundo");
});

test("wav_header", () => {
  const w = wav(Int16Array.of(0, 1000, -1000), RATE);
  expect(Buffer.from(w.subarray(0, 4)).toString()).toBe("RIFF");
  expect(w.length).toBe(44 + 6);
  expect(new DataView(w.buffer).getUint32(24, true)).toBe(16_000);
  expect(rms(new Int16Array(100))).toBe(0);
  expect(rms(new Int16Array(100).fill(16000))).toBeGreaterThan(0.9);
});

test("reads_wav", () => {
  const s = Int16Array.from({ length: 1600 }, (_, i) => i * 7);
  expect(wavSamples(wav(s, RATE))).toEqual(s);
  expect(wavSamples(wav(s, 32_000))).toHaveLength(800);
  expect(() => wavSamples(Buffer.from("RIFF....WAVEjunk"))).toThrow("isn't a 16-bit PCM WAV");
});

function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  out.set(Buffer.from(id), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function riff(...chunks: Uint8Array[]): Uint8Array {
  const body = Buffer.concat([Buffer.from("WAVE"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), body]);
}

function fmt(channels: number, rate: number, bits: number, format = 1): Uint8Array {
  const b = new DataView(new ArrayBuffer(16));
  b.setUint16(0, format, true);
  b.setUint16(2, channels, true);
  b.setUint32(4, rate, true);
  b.setUint16(14, bits, true);
  return chunk("fmt ", new Uint8Array(b.buffer));
}

test("wav reading averages channels, skips other chunks and refuses other formats", () => {
  const pcm = new Uint8Array(Int16Array.of(100, 300, -50, 50).buffer);
  const stereo = riff(fmt(2, RATE, 16), chunk("LIST", Uint8Array.of(1, 2, 3)), chunk("data", pcm));
  expect(wavSamples(stereo)).toEqual(Int16Array.of(200, 0));
  expect(() => wavSamples(riff(fmt(1, RATE, 8), chunk("data", pcm)))).toThrow();
  expect(() => wavSamples(riff(fmt(1, RATE, 16, 3), chunk("data", pcm)))).toThrow();
  expect(() => wavSamples(riff(chunk("data", pcm)))).toThrow();
  expect(wavSamples(riff(fmt(1, RATE, 16, 0xfffe), chunk("data", pcm)))).toHaveLength(4);
});

function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

test("runs_whisper_cli", async () => {
  const dir = tmp("cli");
  const bin = script(dir, "whisper-cli", `echo "$@" > "$(dirname "$0")/args"\necho ' Hello from whisper.'`);
  const wavf = join(dir, "a.wav");
  writeFileSync(wavf, wav(new Int16Array(16000), RATE));
  const out = await outputWithin(bin, ["-m", "model.bin", "-f", wavf, "-l", "pt", "-nt", "-np"], 5000);
  expect(clean(out.stdout)).toBe("Hello from whisper.");
  expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe(`-m model.bin -f ${wavf} -l pt -nt -np`);
});

test("outputWithin stops a program that runs too long", async () => {
  const bin = script(tmp("slow"), "slow", "exec sleep 30");
  const t0 = Date.now();
  await expect(outputWithin(bin, [], 150)).rejects.toThrow("timed out");
  expect(Date.now() - t0).toBeLessThan(5000);
});

test("the external whisper is run with the dictionary as its prompt", async () => {
  const dir = tmp("ext");
  const bin = script(dir, "whisper-cli", `echo "$@" > "${dir}/args"\necho '[BLANK_AUDIO]'\necho ' Olá do whisper.'`);
  process.env.HARBOR_WHISPER = bin;
  expect(voice.engine()).toEqual({ kind: "cli", bin });
  const samples = new Int16Array(16000);
  await expect(voice.whisper(samples, "pt")).rejects.toThrow("put a whisper.cpp ggml model (ggml-base.bin) in");
  mkdirSync(join(box.data, "harbor", "whisper"), { recursive: true });
  const model = join(box.data, "harbor", "whisper", "ggml-base.bin");
  writeFileSync(model, "");
  truncateSync(model, 2_000_000);
  expect(await voice.whisper(samples, "pt", ["SpokPay", "Harbor"])).toBe("Olá do whisper.");
  const args = readFileSync(join(dir, "args"), "utf8").trim();
  expect(args).toContain(`-m ${model} -f `);
  expect(args).toContain("-l pt -t ");
  expect(args).toContain("-nt -np --prompt SpokPay, Harbor.");
  await voice.whisper(samples, "klingon");
  expect(readFileSync(join(dir, "args"), "utf8")).toContain("-l auto");
});

test("a failing external whisper says why", async () => {
  const dir = tmp("ext-fail");
  process.env.HARBOR_WHISPER = script(dir, "whisper-cli", `echo "first" >&2\necho "boom: no model" >&2\nexit 3`);
  mkdirSync(join(box.data, "harbor", "whisper"), { recursive: true });
  const model = join(box.data, "harbor", "whisper", "ggml-tiny.bin");
  writeFileSync(model, "");
  truncateSync(model, 2_000_000);
  const e = await voice.whisper(new Int16Array(16000), "en").catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Fail);
  expect((e as Fail).kind).toBe("err");
  expect((e as Fail).text).toBe(`${join(dir, "whisper-cli")} failed: boom: no model`);
});

test("no whisper model: the first one starts downloading and the caller waits", async () => {
  const urls: string[] = [];
  voice.setFetcher(async (url) => {
    urls.push(url);
    throw new Error("offline");
  });
  const samples = new Int16Array(16000);
  const e = await voice.whisper(samples, "en").catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Fail);
  expect((e as Fail).kind).toBe("wait");
  expect((e as Fail).text).toBe("Getting the Base speech model (0 MB of 160 MB); try again when it's done.");
  expect(voice.downloading()?.[0]).toBe("base");
  await voice.downloadSettled();
  const again = await voice.whisper(samples, "en").catch((x: unknown) => x);
  expect((again as Fail).kind).toBe("err");
  expect((again as Fail).text).toBe("Couldn't download the Base speech model: offline");
  const first = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/main/base-encoder.int8.onnx";
  expect(urls).toEqual([first, first, first]);
});

const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function stream(chunks: Uint8Array[], gate?: Promise<void>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (const [i, part] of chunks.entries()) {
          if (i > 0 && gate) await gate;
          c.enqueue(part);
        }
        c.close();
      },
    }),
  );
}

test("a download writes its files, keeps the ones already there and reports progress", async () => {
  const dir = join(box.data, "dl");
  mkdirSync(dir, { recursive: true });
  const a = Buffer.from("first file, in two pieces");
  const b = Buffer.from("second");
  const have = Buffer.from("already here");
  writeFileSync(join(dir, "have.bin"), have);
  const parts: voice.Part[] = [
    { url: "https://example.test/a", dst: join(dir, "a.bin"), size: a.length, sha256: hex(a) },
    { url: "https://example.test/have", dst: join(dir, "have.bin"), size: have.length, sha256: "" },
    { url: "https://example.test/b", dst: join(dir, "sub", "b.bin"), size: b.length, sha256: "" },
  ];
  const asked: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  voice.setFetcher(async (url) => {
    asked.push(url);
    return url.endsWith("/a") ? stream([a.subarray(0, 10), a.subarray(10)], gate) : stream([b]);
  });
  voice.startDownload("test", parts);
  voice.startDownload("other", []);
  await until(() => (voice.downloading()?.[1] ?? 0) === 10);
  expect(voice.downloading()).toEqual(["test", 10, a.length + have.length + b.length]);
  expect(voice.modelProgress()).toBe("23%");
  open();
  await voice.downloadSettled();
  expect(voice.downloading()).toBeNull();
  expect(voice.takeDownloadError()).toBeNull();
  expect(asked).toEqual(["https://example.test/a", "https://example.test/b"]);
  expect(readFileSync(join(dir, "a.bin"))).toEqual(a);
  expect(readFileSync(join(dir, "sub", "b.bin"))).toEqual(b);
  expect(existsSync(join(dir, "a.part"))).toBe(false);
});

test("a damaged, short or missing download fails with its reason and leaves nothing behind", async () => {
  const dir = join(box.data, "bad");
  const body = Buffer.from("12345");
  const part = (url: string, size: number, sha256: string): voice.Part => ({ url, dst: join(dir, `${url.split("/").pop()}.bin`), size, sha256 });
  voice.setFetcher(async (url) => (url.endsWith("/missing") ? new Response("no", { status: 404 }) : stream([body])));
  const cases: [voice.Part, string][] = [
    [part("https://example.test/sum", 5, "0".repeat(64)), "the download was damaged (checksum mismatch); try again"],
    [part("https://example.test/short", 9, ""), "download incomplete (5 of 9 bytes)"],
    [part("https://example.test/missing", 5, ""), "The requested URL returned error: 404"],
  ];
  for (const [p, why] of cases) {
    voice.startDownload("broken", [p]);
    await voice.downloadSettled();
    expect(voice.downloading()).toBeNull();
    expect(voice.takeDownloadError()).toEqual(["broken", why]);
    expect(voice.takeDownloadError()).toBeNull();
    expect(existsSync(p.dst)).toBe(false);
    expect(existsSync(join(dir, `${p.url.split("/").pop()}.part`))).toBe(false);
  }
});

test("a server error is retried, a client error is not", async () => {
  const dir = join(box.data, "retry");
  const body = Buffer.from("payload");
  let tries = 0;
  voice.setFetcher(async () => (++tries < 3 ? new Response("later", { status: 503 }) : stream([body])));
  voice.startDownload("retry", [{ url: "https://example.test/r", dst: join(dir, "r.bin"), size: body.length, sha256: "" }]);
  await voice.downloadSettled();
  expect(voice.takeDownloadError()).toBeNull();
  expect(tries).toBe(3);
  tries = 0;
  voice.setFetcher(async () => {
    tries += 1;
    return new Response("no", { status: 403 });
  });
  voice.startDownload("denied", [{ url: "https://example.test/d", dst: join(dir, "d.bin"), size: 1, sha256: "" }]);
  await voice.downloadSettled();
  expect(voice.takeDownloadError()?.[1]).toBe("The requested URL returned error: 403");
  expect(tries).toBe(1);
});

test("Whisper models are known by name and found when all their files are there", () => {
  expect(voice.installed("base")).toBe(false);
  expect(voice.currentModel()).toBeNull();
  for (const [name, , total] of voice.MODELS) {
    expect(voice.modelFiles(name).reduce((n, f) => n + f[1], 0)).toBe(total);
  }
  expect(voice.modelFiles("huge")).toEqual([]);
  expect(voice.modelFiles("constructor")).toEqual([]);
  const dir = voice.modelDir("small");
  mkdirSync(dir, { recursive: true });
  for (const [f, size] of voice.modelFiles("small")) {
    writeFileSync(join(dir, f), "");
    truncateSync(join(dir, f), size);
  }
  expect(voice.installed("small")).toBe(true);
  expect(voice.currentModel()).toBe("small");
  voice.setConfig("pt", "tiny");
  expect(voice.config()).toEqual(["auto", "tiny"]);
  expect(voice.currentModel()).toBe("small");
  voice.setConfig("", "");
  expect(voice.config()).toEqual(["auto", ""]);
});

test("the recorder is PipeWire's, else PulseAudio's, else none", () => {
  const bin = tmp("bin");
  process.env.PATH = bin;
  expect(voice.recorder()).toBeNull();
  expect(voice.cantRecord()).toContain("neither pw-record (PipeWire) nor parecord (PulseAudio)");
  script(bin, "parecord", "true");
  expect(voice.recorder()?.args).toContain("--rate=16000");
  script(bin, "pw-record", "true");
  expect(voice.recorder()?.bin).toBe(join(bin, "pw-record"));
  expect(voice.cantRecord()).toBeNull();
});

test("a recording collects what the recorder prints and stops on request", async () => {
  const dir = tmp("rec");
  const source = join(dir, "pcm");
  writeFileSync(source, Buffer.from(Int16Array.from({ length: 4000 }, (_, i) => (i % 2 ? 12000 : -12000)).buffer));
  fakeRecorder(join(dir, "bin"), source, 6401);
  let woke = 0;
  const rec = Recording.start(() => {
    woke += 1;
  });
  await until(() => rec.length() >= 3200);
  expect(rec.level()).toBeGreaterThan(0.9);
  expect(rec.tooLong()).toBe(false);
  expect(woke).toBeGreaterThan(0);
  const samples = await rec.stop();
  expect(samples).toHaveLength(3200);
  expect(samples[0]).toBe(-12000);
  expect(samples[1]).toBe(12000);
  expect((await rec.stop()).length).toBe(0);
});

test("recording without a recorder fails at once", () => {
  process.env.PATH = tmp("empty");
  expect(() => Recording.start(() => undefined)).toThrow("no recorder");
});

test("labels and sizes read well", () => {
  expect(voice.label("parakeet")).toBe("Parakeet");
  expect(voice.capital("")).toBe("");
  expect(voice.capital("élan")).toBe("Élan");
  expect(voice.megabytes(160_609_290)).toBe("160 MB");
});

test("microphone enumeration hides monitor sources and uses stable source names", () => {
  expect(voice.pulseInputs([{ name: "speaker.monitor", description: "Output" }, { name: "usb-mic", description: "USB microphone", monitor_of_sink: 4294967295 }])).toEqual([{ id: "usb-mic", label: "USB microphone" }]);
  // pactl's JSON as newer versions write it: monitor_source names the sink of a monitor, "" otherwise.
  expect(voice.pulseInputs([{ name: "out-mon", description: "Monitor", monitor_source: "out" }, { name: "mic", description: "Built-in", monitor_source: "" }, { name: "cam", monitor_of_sink: "n/a" }, { name: "loop", monitor_of_sink: "speakers" }])).toEqual([
    { id: "mic", label: "Built-in" },
    { id: "cam", label: "cam" },
  ]);
  expect(voice.pipewireInputs([{ info: { props: { "media.class": "Audio/Source", "node.name": "mic", "node.description": "Microphone" } } }, { info: { props: { "media.class": "Audio/Sink", "node.name": "speaker" } } }])).toEqual([{ id: "mic", label: "Microphone" }]);
});

test("the Parakeet model comes in the background: never on a full disk, its failures stay quiet, a waiting dictation hears them", async () => {
  const asked: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  voice.setFetcher(async (url) => {
    asked.push(url);
    await gate;
    return new Response("no", { status: 404 });
  });
  const full = voice.keepParakeet({ firstMs: 0, free: () => 0 });
  await Bun.sleep(30);
  full();
  expect(asked).toEqual([]);
  const stop = voice.keepParakeet({ firstMs: 0, free: () => 10 * 1024 ** 3 });
  try {
    await until(() => asked.length > 0);
    expect(asked[0]).toContain("huggingface.co");
    expect(voice.downloading()?.[0]).toBe("parakeet");
    open();
    await voice.downloadSettled();
    await Bun.sleep(10);
    expect(voice.takeDownloadError()).toBeNull();
  } finally {
    stop();
  }
  // A dictation waiting for the model makes the download under way a loud one: its failure is told.
  voice.startDownload("parakeet", [{ url: "https://example.test/p", dst: join(box.data, "p.bin"), size: 3, sha256: "" }], true);
  voice.startDownload("parakeet");
  await voice.downloadSettled();
  expect(voice.takeDownloadError()?.[0]).toBe("parakeet");
});
