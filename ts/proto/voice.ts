import { join } from "node:path";
import sherpa from "sherpa-onnx-node";

/** Parakeet TDT 0.6B v3 int8, configured as parakeet.rs does. */
export function recognizer(dir: string, threads: number) {
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: join(dir, "encoder.int8.onnx"), decoder: join(dir, "decoder.int8.onnx"), joiner: join(dir, "joiner.int8.onnx") },
      tokens: join(dir, "tokens.txt"),
      numThreads: threads,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
  });
}

export function transcribe(r: ReturnType<typeof recognizer>, wav: string): string {
  const stream = r.createStream();
  stream.acceptWaveform(sherpa.readWave(wav));
  r.decode(stream);
  return r.getResult(stream).text.trim();
}
