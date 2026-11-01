declare module "sherpa-onnx-node" {
  export interface Wave {
    samples: Float32Array;
    sampleRate: number;
  }
  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads: number;
      provider: "cpu";
      debug: number;
      modelType: string;
    };
    decodingMethod?: string;
  }
  export interface OfflineStream {
    acceptWaveform(w: Wave): void;
  }
  export interface OfflineResult {
    text: string;
    lang?: string;
  }
  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): OfflineResult;
  }
  export function readWave(path: string): Wave;
  const sherpa: { OfflineRecognizer: typeof OfflineRecognizer; readWave: typeof readWave };
  export default sherpa;
}
