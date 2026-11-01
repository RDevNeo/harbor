declare module "sherpa-onnx-node" {
  export interface Wave {
    samples: Float32Array;
    sampleRate: number;
  }
  export interface OfflineRecognizerConfig {
    featConfig?: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer?: { encoder: string; decoder: string; joiner: string };
      whisper?: { encoder: string; decoder: string; language: string; task: string; tailPaddings: number };
      tokens: string;
      numThreads: number;
      provider: "cpu";
      debug: number;
      modelType?: string;
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
  export interface VadConfig {
    sileroVad: { model: string; threshold: number; minSilenceDuration: number; minSpeechDuration: number; windowSize: number; maxSpeechDuration: number };
    sampleRate: number;
    numThreads: number;
    provider: "cpu";
    debug: number;
  }
  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }
  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    pop(): void;
    flush(): void;
  }
  export function readWave(path: string): Wave;
  const sherpa: { OfflineRecognizer: typeof OfflineRecognizer; Vad: typeof Vad; readWave: typeof readWave };
  export default sherpa;
}
