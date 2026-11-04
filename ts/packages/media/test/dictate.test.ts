import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as dictate from "../src/dictate.ts";
import { type Ask, CLEANUP_SYSTEM, type Mesh, type MeshPeer, cleanupText, newWords, order, plausible, plausibleWith, score } from "../src/dictate.ts";
import * as dictwords from "../src/dictwords.ts";
import * as parakeet from "../src/parakeet.ts";
import * as voice from "../src/voice.ts";
import { Fail } from "../src/voice.ts";
import { type Sandbox, findModel, installModel, pidAlive, sandbox, wavFile } from "./fixture.ts";

describe("settings and cleanup", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
  });
  afterEach(async () => {
    await box.restore();
  });

  test("cleanup_keeps_mixed_languages", () => {
    const raw = "é, tipo, eu quero que você faça o deploy and then check the logs on the server";
    expect(plausible(raw, "Eu quero que você faça o deploy and then check the logs on the server.")).toBe(true);
    expect(plausible(raw, "Eu quero que você faça o deploy e depois verifique os registros no servidor.")).toBe(false);
    expect(plausible(raw, "I want you to do the deploy and then check the logs on the server.")).toBe(false);
    expect(plausible("we should merge it their now", "We should merge it there now.")).toBe(true);
    expect(CLEANUP_SYSTEM).toContain("Keep every word in the language it was spoken");
  });

  test("routes_to_most_free_memory_local_on_near_ties", () => {
    expect(order(4000, [["a", 9000], ["b", 4300]])).toEqual(["a", null, "b"]);
    expect(order(4000, [["a", 4400]])).toEqual([null, "a"]);
    expect(order(0, [["a", 100], ["b", 900]])).toEqual(["b", "a", null]);
    expect(order<string>(500, [])).toEqual([null]);
  });

  test("scores_count_a_loaded_model", () => {
    expect(score({ mem_available_mb: 3000, model_state: "loaded", model_mb: 670 })).toBe(3670);
    expect(score({ mem_available_mb: 3000, model_state: "ready", model_mb: 670 })).toBe(3000);
    expect(score({ mem_available_mb: 3000, model_state: "downloading" })).toBeNull();
    expect(score({ error: "nope" })).toBeNull();
    expect(score(null)).toBeNull();
  });

  test("dictionary_terms_count_as_said", () => {
    const dict = dictwords.parse([{ term: "SpokPayCRM" }]);
    expect(plausibleWith("open the spook pay see are em", "Open the SpokPayCRM.", dict)).toBe(true);
    expect(plausible("open the spook pay see are em now", "Open the SpokPayCRM thing quickly now.")).toBe(false);
  });

  test("cleanup_falls_back_to_the_raw_text", async () => {
    expect(await cleanupText("  um so I think we should uh ship it  ")).toBe("um so I think we should uh ship it");
    expect(plausible("um so we ship it", "So we ship it.")).toBe(true);
    expect(plausible("ship it", "")).toBe(false);
    expect(plausible("ship it", "Sure! Here is a long answer to your question about shipping it today.")).toBe(false);
  });

  test("cleanup_with_claude_and_its_fallback", async () => {
    const raw = "um so I think we should uh ship it on friday no wait I mean on monday";
    const asked: { system: string; prompt: string; ms: number }[] = [];
    dictate.setAccount(async (system, prompt, ms) => {
      asked.push({ system, prompt, ms });
      return "I think we should ship it on Monday.";
    });
    const clean = await cleanupText(raw);
    expect(clean).not.toBe(raw);
    expect(clean.toLowerCase()).toContain("monday");
    expect(clean.toLowerCase()).not.toContain("friday");
    expect(clean).not.toContain(" um ");
    expect(asked).toEqual([{ system: CLEANUP_SYSTEM, prompt: `<dictation>\n${raw}\n</dictation>`, ms: 8000 }]);
    dictate.setAccount(async () => {
      throw new Error("claude: command not found");
    });
    expect(await cleanupText(raw)).toBe(raw);
    dictate.setAccount(null);
    expect(await cleanupText(raw)).toBe(raw);
  });

  test("cleanup_with_claude_keeps_mixed_languages", async () => {
    const cleaned: Record<string, string> = {
      "então eu acho que a gente devia tipo mudar o layout da tela and then make sure the tests still pass before we ship it": "Então eu acho que a gente devia mudar o layout da tela and then make sure the tests still pass before we ship it.",
      "ok so the build is broken again né e eu não sei por que o teste de integração falha só no CI": "Ok, so the build is broken again e eu não sei por que o teste de integração falha só no CI.",
    };
    const systems = new Set<string>();
    dictate.setAccount(async (system, prompt) => {
      systems.add(system);
      const raw = prompt.replace(/^<dictation>\n|\n<\/dictation>$/g, "");
      return cleaned[raw] ?? "";
    });
    for (const raw of Object.keys(cleaned)) {
      const clean = await cleanupText(raw);
      expect(clean).not.toBe(raw);
      expect(newWords(raw, clean)).toBe(0);
    }
    expect([...systems]).toEqual([CLEANUP_SYSTEM]);
    dictate.setAccount(async () => "Então eu acho que a gente devia mudar o layout da tela e depois garantir que os testes passem antes de lançar.");
    const raw = "então eu acho que a gente devia tipo mudar o layout da tela and then make sure the tests still pass before we ship it";
    expect(await cleanupText(raw)).toBe(raw);
  });

  test("cleanup_with_claude_spells_dictionary_terms", async () => {
    const dict = dictwords.parse([{ term: "SpokPay" }, { term: "SpokPayCRM" }, { term: "Harbor" }]);
    dictate.setWords({ dict });
    let system = "";
    dictate.setAccount(async (s, prompt) => {
      system = s;
      return prompt.includes("checkout") ? "So the SpokPay checkout is broken and the SpokPayCRM too." : "Então eu abri o Harbor no celular e o SpokPay não carregou.";
    });
    const cases: [string, string[]][] = [
      ["um so the spoke pay checkout is broken and the spook pay see are em too", ["SpokPay", "SpokPayCRM"]],
      ["então eu abri o harbour no celular e o spock pay não carregou", ["Harbor", "SpokPay"]],
    ];
    for (const [raw, want] of cases) {
      const clean = await cleanupText(raw);
      for (const w of want) expect(clean, `${w} missing`).toContain(w);
    }
    expect(system).toContain("- SpokPayCRM");
    expect(system).toStartWith(CLEANUP_SYSTEM);
    expect(dictate.cleanupSystem([{ term: "Harbor", sounds: ["harbour", "arbor"] }])).toContain("- Harbor (may sound like: harbour, arbor)");
  });

  test("a cleanup of fewer than eight words is not asked for", async () => {
    let calls = 0;
    const ask: Ask = async () => {
      calls += 1;
      return "Something else entirely, translated maybe.";
    };
    dictate.setAccount(ask);
    expect(await cleanupText(" ok send ")).toBe("ok send");
    expect(await dictate.cleanupRun("faz o deploy and check the logs")).toEqual({ text: "faz o deploy and check the logs", how: "short" });
    expect(calls).toBe(0);
    expect((await dictate.cleanupRun("faz o deploy and then check the logs")).how).toBe("rejected");
    expect(calls).toBe(1);
    dictate.setAccount(null);
    expect((await dictate.cleanupRun("faz o deploy and then check the logs")).how).toBe("no account");
  });

  test("one log line per dictation says where, how long, how warm and what the cleanup did", () => {
    expect(dictate.logLine({ from: "this PC", audioMs: 4200, host: "desk", tookMs: 1300, transcribeMs: 1300, model: "warm", cleanup: "off", words: 12 })).toBe("harbor: dictation from this PC: 4.2 s of audio on desk in 1.3 s, model warm, cleanup off, 12 words");
    expect(dictate.logLine({ from: "a phone", audioMs: 9000, host: "desk", tookMs: 6100, transcribeMs: 2000, model: "cold", cleanup: "kept", words: 30, error: "laptop isn't reachable; transcribed elsewhere." })).toBe(
      "harbor: dictation from a phone: 9.0 s of audio on desk in 6.1 s (transcribed in 2.0 s), model cold, cleanup kept, 30 words, error shown: laptop isn't reachable; transcribed elsewhere.",
    );
  });

  test("settings are kept for the api and handed to the ui once", () => {
    expect(dictate.engine()).toBe("parakeet");
    expect(dictate.cleanupOn()).toBe(false);
    expect(dictate.takeDirty()).toBeNull();
    dictate.set({ engine: "whisper", cleanup: true, keepMin: 99_999 });
    expect(dictate.engine()).toBe("parakeet");
    expect(dictate.cleanupOn()).toBe(true);
    expect(parakeet.keepMin()).toBe(24 * 60);
    dictate.set({ cleanup: false, keepMin: 5 });
    expect(dictate.takeDirty()).toBeNull();
    dictate.set({ keepMin: 1 }, true);
    expect(parakeet.keepMin()).toBe(5);
    dictate.setWords({ commands: false, dict: dictwords.parse([{ term: "Harbor" }]) }, true);
    expect(dictate.takeDirty()).toEqual({ cleanup: false, keepMin: 5, commands: true, dict: [{ term: "Harbor", sounds: [] }] });
    expect(dictate.takeDirty()).toBeNull();
    dictate.set({ cleanup: true }, true);
    expect(dictate.takeDirty()?.cleanup).toBe(true);
    dictate.set({ engine: "unknown" });
    expect(dictate.engine()).toBe("parakeet");
  });

  test("status tells a peer what this PC can do", () => {
    process.env.HARBOR_TEST_MEMAVAIL_MB = "3210";
    dictate.setWords({ dict: dictwords.parse([{ term: "Harbor", sounds: ["harbour"] }]) });
    const s = dictate.status("desk");
    expect(s).toEqual({
      engine: "parakeet",
      model_state: "none",
      model_mb: 671,
      mem_available_mb: 3210,
      cleanup: false,
      keep_loaded_min: 5,
      host: "desk",
      commands: true,
      dictionary: [{ term: "Harbor", sounds: ["harbour"] }],
    });
    expect(dictate.status("").host).not.toBe("");
    expect(dictate.readyHere()).toBe(false);
  });

  test("without the model, a first dictation starts its download and then reports why it failed", async () => {
    voice.setFetcher(async () => {
      throw new Error("offline");
    });
    const samples = new Int16Array(16000);
    const e = await dictate.local(samples, "auto").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Fail);
    expect((e as Fail).kind).toBe("wait");
    expect((e as Fail).text).toBe("Getting the Parakeet speech model (0 MB of 671 MB); try again when it's done.");
    expect(dictate.modelState()).toEqual(["downloading", 0]);
    await voice.downloadSettled();
    const again = await dictate.local(samples, "auto").catch((x: unknown) => x);
    expect((again as Fail).kind).toBe("err");
    expect((again as Fail).text).toBe("Couldn't download the Parakeet speech model: offline");
    await expect(dictate.local(new Int16Array(100), "auto")).rejects.toThrow("Nothing was recorded");
  });

  test("a peer's recording is refused when it is not a WAV and when this PC cannot transcribe it", async () => {
    const mesh = fakeMesh([]);
    expect(await dictate.servePeer(mesh, Buffer.from("junk"), "auto")).toEqual([400, { error: "The recording isn't a 16-bit PCM WAV file." }]);
    voice.setFetcher(async () => {
      throw new Error("offline");
    });
    const [status, body] = await dictate.servePeer(mesh, voice.wav(new Int16Array(16000), voice.RATE), "auto");
    expect(status).toBe(409);
    expect(body.error).toStartWith("Getting the Parakeet speech model");
    await voice.downloadSettled();
    voice.takeDownloadError();
  });
});

interface Peer extends MeshPeer {
  addr: string;
}

const peerB: Peer = { id: "rig-b", name: "rig-b", online: true, addr: "b" };

interface Rig extends Mesh<Peer> {
  asks: string[];
  posts: string[];
  reply: [number, unknown] | "down";
  voice: unknown;
  /** Peers that refuse connections, by id. */
  down: string[];
}

function fakeMesh(peers: Peer[]): Rig {
  const rig: Rig = {
    asks: [],
    posts: [],
    reply: [200, { text: "hello from b", host: "rig-b" }],
    down: [],
    voice: { mem_available_mb: 4000, model_state: "ready", model_mb: 670 },
    on: () => true,
    me: () => ({ name: "rig-a", id: "rig-a" }),
    peers: () => peers.filter((p) => p.online),
    known: () => peers,
    http: async (peer, method, path, body) => {
      if (rig.reply === "down") throw new Error("connection refused");
      if (rig.down.includes(peer.id)) throw new Error("connection refused");
      if (method === "GET") {
        rig.asks.push(`${peer.name} ${path}`);
        return [200, rig.voice];
      }
      expect(body?.ctype).toBe("audio/wav");
      expect(body?.data.length).toBeGreaterThan(44);
      rig.posts.push(path);
      return rig.reply;
    },
  };
  return rig;
}

describe("routing without a model", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
  });
  afterEach(async () => {
    await box.restore();
  });

  test("a PC with no model hands the recording to a peer that can, and skips peers that fail", async () => {
    process.env.HARBOR_TEST_MEMAVAIL_MB = "500";
    const rig = fakeMesh([peerB, { ...peerB, id: "rig-c", name: "rig-c", online: false }]);
    const samples = new Int16Array(16000);
    dictate.setWords({ dict: dictwords.parse([{ term: "Harbor", sounds: ["harbour"] }]) });
    const d = await dictate.transcribe(rig, samples, "klingon!", { cleanup: false, commands: true, localOnly: false });
    expect(d).toEqual({ text: "hello from b", raw: null, host: "rig-b", send: false });
    expect(rig.asks).toEqual(["rig-b /mesh/v1/voice"]);
    expect(rig.posts).toEqual(["/mesh/v1/transcribe?lang=auto"]);
    rig.reply = [200, { text: "open the harbour. press enter", host: "" }];
    const sent = await dictate.transcribe(rig, samples, "pt", { cleanup: false, commands: true, localOnly: false });
    expect(sent).toEqual({ text: "open the Harbor.", raw: null, host: "rig-b", send: true });
    expect(rig.posts[1]).toBe("/mesh/v1/transcribe?lang=pt");
    const kept = await dictate.transcribe(rig, samples, "pt", { cleanup: false, commands: false, localOnly: false });
    expect(kept.send).toBe(false);
    expect(kept.text).toBe("open the Harbor. press enter");
    voice.setFetcher(async () => {
      throw new Error("offline");
    });
    rig.reply = [409, { error: "nope" }];
    const e = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: true, localOnly: false }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Fail);
    expect((e as Fail).kind).toBe("wait");
    await voice.downloadSettled();
    voice.takeDownloadError();
  });

  test("the chosen PC transcribes first, is warmed up while the person speaks, and its failure falls back once with a warning", async () => {
    process.env.HARBOR_TEST_MEMAVAIL_MB = "500";
    const peerC: Peer = { id: "rig-c", name: "rig-c", online: true, addr: "c" };
    const rig = fakeMesh([peerB, peerC]);
    const samples = new Int16Array(16000);
    // Automatic: no warm-up ping (this PC preloads its own), rig-b and rig-c are asked.
    expect(dictate.warmUp(rig)).toBeNull();
    dictate.setHost("rig-c");
    expect(dictate.warmUp(rig)).toBe("rig-c");
    expect(rig.asks).toEqual(["rig-c /mesh/v1/voice?warm=1"]);
    rig.asks = [];
    rig.reply = [200, { text: "from c", host: "rig-c", model: "warm" }];
    const d = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false });
    expect(d).toEqual({ text: "from c", raw: null, host: "rig-c", send: false });
    // Straight there: no asking around for free memory.
    expect(rig.asks).toEqual([]);
    // rig-c down: the others take it, the person is told once.
    rig.down = ["rig-c"];
    rig.reply = [200, { text: "from b", host: "rig-b" }];
    const first = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false });
    expect(first.host).toBe("rig-b");
    expect(first.warn).toBe("rig-c couldn't transcribe (connection refused); transcribed elsewhere.");
    expect(rig.asks).toEqual(["rig-b /mesh/v1/voice"]);
    const second = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false });
    expect([second.host, second.warn]).toEqual(["rig-b", undefined]);
    // Back up: it works again, and a later failure warns again.
    rig.down = [];
    rig.reply = [200, { text: "from c", host: "rig-c" }];
    expect((await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false })).host).toBe("rig-c");
    peerC.online = false;
    rig.reply = [200, { text: "from b", host: "rig-b" }];
    const offline = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false });
    expect([offline.host, offline.warn]).toEqual(["rig-b", "rig-c isn't reachable; transcribed elsewhere."]);
    expect(dictate.warmUp(rig)).toBeNull();
    // This PC chosen: as Automatic, without a warning.
    dictate.setHost("rig-a");
    expect(dictate.warmUp(rig)).toBeNull();
    const mine = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false });
    expect([mine.host, mine.warn]).toEqual(["rig-b", undefined]);
  });

  test("an SSH device of this PC transcribes when chosen, is warmed up, and falls back like a PC", async () => {
    process.env.HARBOR_TEST_MEMAVAIL_MB = "500";
    const rig = fakeMesh([peerB]);
    const calls: string[] = [];
    let fails: string | null = null;
    rig.speech = {
      list: () => [{ id: "ssh:1", name: "laptop" }],
      transcribe: async (id, samples, lang) => {
        calls.push(`transcribe ${id} ${samples.length} ${lang}`);
        if (fails !== null) throw new Error(fails);
        return { text: "olá, the deploy failed", model: "parakeet-mlx warm" };
      },
      warm: (id) => void calls.push(`warm ${id}`),
      prepare: (id) => void calls.push(`prepare ${id}`),
      state: () => "",
    };
    expect(dictate.parseChoice("rig-a#ssh:1")).toEqual({ pc: "rig-a", device: "ssh:1" });
    expect(dictate.parseChoice("ts:desk")).toEqual({ pc: "ts:desk", device: null });
    dictate.setHost(dictate.deviceChoice("rig-a", "ssh:1"));
    expect(dictate.warmUp(rig)).toBe("laptop");
    const samples = new Int16Array(16000);
    const d = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false });
    expect(d).toEqual({ text: "olá, the deploy failed", raw: null, host: "laptop", send: false });
    expect(calls).toEqual(["warm ssh:1", "transcribe ssh:1 16000 auto"]);
    expect(rig.asks).toEqual([]);
    // Asleep: Automatic takes it (rig-b), told once.
    fails = "laptop didn't answer in 6 s";
    rig.reply = [200, { text: "from b", host: "rig-b" }];
    const first = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false });
    expect([first.host, first.warn]).toEqual(["rig-b", "laptop couldn't transcribe (laptop didn't answer in 6 s); transcribed elsewhere."]);
    const second = await dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly: false });
    expect([second.host, second.warn]).toEqual(["rig-b", undefined]);
    // A peer's own SSH device: asked through that peer, and the peer stays a fallback when it fails.
    fails = null;
    rig.voice = { mem_available_mb: 4000, model_state: "ready", model_mb: 670, devices: [{ id: "ssh:4", name: "studio" }] };
    await dictate.refreshPeerDevices(rig);
    expect(dictate.devicesOfPeer("rig-b")).toEqual([{ id: "ssh:4", name: "studio" }]);
    dictate.setHost(dictate.deviceChoice("rig-b", "ssh:4"));
    rig.asks = [];
    expect(dictate.warmUp(rig)).toBe("studio");
    expect(rig.asks).toEqual(["rig-b /mesh/v1/voice?warm=1&device=ssh%3A4"]);
    rig.posts = [];
    rig.reply = [200, { text: "from studio", host: "studio", model: "parakeet-mlx warm" }];
    const via = await dictate.transcribe(rig, samples, "pt", { cleanup: false, commands: false, localOnly: false });
    expect([via.host, via.text]).toEqual(["studio", "from studio"]);
    expect(rig.posts).toEqual(["/mesh/v1/transcribe?lang=pt&device=ssh%3A4"]);
  });

  test("a peer's recording for one of this PC's SSH devices goes there, never here", async () => {
    const rig = fakeMesh([peerB]);
    let fails: string | null = null;
    rig.speech = {
      list: () => [{ id: "ssh:1", name: "laptop" }],
      transcribe: async () => {
        if (fails !== null) throw new Error(fails);
        return { text: "hi", model: "parakeet-mlx cold" };
      },
      warm: () => undefined,
      prepare: () => undefined,
      state: () => "",
    };
    const wav = voice.wav(new Int16Array(16000), voice.RATE);
    expect(await dictate.servePeer(rig, wav, "auto", "rig-b", "ssh:1")).toEqual([200, { text: "hi", host: "laptop", model: "parakeet-mlx cold" }]);
    fails = "laptop can't be reached";
    expect(await dictate.servePeer(rig, wav, "auto", "rig-b", "ssh:1")).toEqual([409, { error: "laptop can't be reached" }]);
    expect(dictate.status("rig-a", rig.speech).devices).toEqual([{ id: "ssh:1", name: "laptop" }]);
    expect(rig.posts).toEqual([]);
  });

  test("a PC serving a peer transcribes itself whatever PC it chose (no loops)", async () => {
    const rig = fakeMesh([peerB]);
    dictate.setHost("rig-b");
    voice.setFetcher(async () => {
      throw new Error("offline");
    });
    const [status, body] = await dictate.servePeer(rig, voice.wav(new Int16Array(16000), voice.RATE), "auto", "rig-b");
    expect(status).toBe(409);
    expect(body.error).toStartWith("Getting the Parakeet speech model");
    expect(rig.posts).toEqual([]);
    expect(rig.asks).toEqual([]);
    await voice.downloadSettled();
    voice.takeDownloadError();
  });

  test("a mesh that is off, or peers that do not answer, leave this PC", async () => {
    const rig = fakeMesh([peerB]);
    rig.on = () => false;
    voice.setFetcher(async () => {
      throw new Error("offline");
    });
    const e = await dictate.transcribe(rig, new Int16Array(16000), "auto", { cleanup: false, commands: false, localOnly: false }).catch((x: unknown) => x);
    expect((e as Fail).kind).toBe("wait");
    expect(rig.asks).toEqual([]);
    await voice.downloadSettled();
    voice.takeDownloadError();
  });
});

const model = findModel();
if (!model) console.warn("SKIPPED speech tests: no Parakeet model on this PC (set HARBOR_TEST_PARAKEET_DIR to a folder with its files and test_wavs/en.wav)");

describe.skipIf(!model)("with the Parakeet model", () => {
  let box: Sandbox;
  let src: NonNullable<typeof model>;

  beforeAll(() => {
    src = model as NonNullable<typeof model>;
    box = sandbox();
    installModel(src);
  });
  beforeEach(() => {
    process.env.HARBOR_TEST_MEMAVAIL_MB = "4000";
  });
  afterEach(async () => {
    box.reset();
    await parakeet.unload();
  });
  afterAll(async () => {
    await parakeet.unload();
    await box.restore();
  });

  test("routes_between_two_hubs", async () => {
    const samples = wavFile(src, "en");
    const rig = fakeMesh([peerB]);
    dictate.set({ engine: "parakeet", cleanup: false, keepMin: 5 });
    const run = (localOnly: boolean) => dictate.transcribe(rig, samples, "auto", { cleanup: false, commands: false, localOnly });
    const theirs = score(rig.voice) as number;
    // Much less free memory here: the peer transcribes.
    process.env.HARBOR_TEST_MEMAVAIL_MB = String(Math.floor(theirs / 4));
    let d = await run(false);
    expect(d.host).toBe("rig-b");
    expect(d.text).toBe("hello from b");
    // A near tie (within 10%): here. (The peer has the model loaded now: it counts it.)
    rig.voice = { mem_available_mb: 4000, model_state: "loaded", model_mb: 670 };
    process.env.HARBOR_TEST_MEMAVAIL_MB = String(Math.floor((score(rig.voice) as number) * 0.95));
    d = await run(false);
    expect(d.host).toBe("rig-a");
    expect(d.text.toLowerCase()).toContain("ask not what your country can do for you");
    expect(rig.posts).toHaveLength(1);
    // A peer that refuses: this PC takes over.
    process.env.HARBOR_TEST_MEMAVAIL_MB = "100";
    rig.reply = [409, { error: "nope" }];
    d = await run(false);
    expect(d.host).toBe("rig-a");
    expect(rig.posts).toHaveLength(2);
    // `local`: never forwarded.
    process.env.HARBOR_TEST_MEMAVAIL_MB = "1";
    expect((await run(true)).host).toBe("rig-a");
    expect(rig.posts).toHaveLength(2);
    // The peer unreachable: skipped, here as the last resort.
    rig.reply = "down";
    const t0 = Date.now();
    d = await run(false);
    expect(d.host).toBe("rig-a");
    expect(Date.now() - t0).toBeLessThan(8000);
    await parakeet.unload();
  }, 60_000);

  test("a transcript has its dictionary spelled, its commands taken out and its cleanup done", async () => {
    const samples = wavFile(src, "en");
    const rig = fakeMesh([]);
    dictate.setWords({ dict: dictwords.parse([{ term: "Countree", sounds: ["country"] }]) });
    dictate.setAccount(async (_s, prompt) => prompt.replace(/^<dictation>\n|\n<\/dictation>$/g, "").toUpperCase());
    const d = await dictate.transcribe(rig, samples, "auto", { cleanup: true, commands: true, localOnly: false });
    expect(d.host).toBe("rig-a");
    expect(d.raw).toContain("Countree");
    expect(d.raw).not.toContain("country");
    expect(d.text).toBe((d.raw as string).toUpperCase().replaceAll("COUNTREE", "Countree"));
    expect(d.send).toBe(false);
    const peer = await dictate.servePeer(rig, voice.wav(samples, voice.RATE), "en");
    expect(peer[0]).toBe(200);
    expect(peer[1].text?.toLowerCase()).toContain("country");
    expect(peer[1].host).toBe("rig-a");
  }, 60_000);

  test("parakeet_transcribes_and_frees_its_memory", async () => {
    const samples = wavFile(src, "en");
    dictate.set({ engine: "parakeet", cleanup: false, keepMin: 5 });
    expect(dictate.modelState()).toEqual(["ready", null]);
    const t0 = Date.now();
    const text = await dictate.local(samples, "auto");
    console.log(`parakeet: ${Date.now() - t0} ms: ${text}`);
    expect(text.toLowerCase()).toContain("ask not what your country can do for you");
    expect(parakeet.loaded()).toBe(true);
    expect(dictate.status("pc").model_state).toBe("loaded");
    const pid = parakeet.workerPid() as number;
    expect(pidAlive(pid)).toBe(true);
    const t1 = Date.now();
    expect(await dictate.local(samples, "en")).toBe(text);
    console.log(`again (loaded): ${Date.now() - t1} ms`);
    expect(parakeet.workerPid()).toBe(pid);
    parakeet.setKeepMin(0);
    await parakeet.unload();
    expect(parakeet.loaded()).toBe(false);
    expect(parakeet.workerPid()).toBeNull();
    expect(pidAlive(pid)).toBe(false);
    expect(dictate.status("pc").model_state).toBe("ready");
  }, 60_000);
});
