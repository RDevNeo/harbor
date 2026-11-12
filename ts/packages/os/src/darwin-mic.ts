// macOS's microphone through CoreAudio's AudioQueue (bun:ffi): 16 kHz mono signed 16-bit, as pw-record
// gives it on Linux. Run in its own process (`harbor record-mic`), which writes the samples to stdout until
// it's killed: the queue's callbacks come on CoreAudio's thread and stay out of Harbor's window process.
import { dlopen, FFIType, JSCallback, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";

const AT = dlopen("/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox", {
  AudioQueueNewInput: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  AudioQueueAllocateBuffer: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  AudioQueueEnqueueBuffer: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  AudioQueueStart: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  AudioQueueStop: { args: [FFIType.ptr, FFIType.bool], returns: FFIType.i32 },
}).symbols;

export const RATE = 16_000;
/** 100 ms of samples per buffer, three buffers in turn. */
const BUFFER_BYTES = (RATE / 10) * 2;
const BUFFERS = 3;

/** AudioStreamBasicDescription for 16 kHz mono signed 16-bit packed linear PCM. */
function format(): Uint8Array {
  const b = new DataView(new ArrayBuffer(40));
  b.setFloat64(0, RATE, true);
  b.setUint32(8, 0x6c70636d, true); // 'lpcm'
  b.setUint32(12, 0x4 | 0x8, true); // signed integer, packed
  b.setUint32(16, 2, true); // bytes per packet
  b.setUint32(20, 1, true); // frames per packet
  b.setUint32(24, 2, true); // bytes per frame
  b.setUint32(28, 1, true); // channels
  b.setUint32(32, 16, true); // bits per channel
  return new Uint8Array(b.buffer);
}

/**
 * Records until `stop` is called: each buffer's samples go to `sink`. Throws when the queue can't start
 * (no microphone, or the user said no to Harbor using it).
 */
export function record(sink: (samples: Uint8Array) => void): () => void {
  const asbd = format();
  const queueOut = new BigUint64Array(1);
  let queue: Pointer | null = null;
  // CoreAudio calls this on its own thread: threadsafe, it runs on Bun's thread, in order.
  const cb = new JSCallback(
    (_user: Pointer | null, q: Pointer, buf: Pointer) => {
      // AudioQueueBuffer: UInt32 capacity; void *mAudioData (at 8); UInt32 mAudioDataByteSize (at 16).
      const data = read.ptr(buf, 8) as Pointer;
      const size = read.u32(buf, 16);
      if (size > 0) sink(new Uint8Array(toArrayBuffer(data, 0, size)).slice());
      AT.AudioQueueEnqueueBuffer(q, buf, 0, null);
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.void, threadsafe: true },
  );
  const err = AT.AudioQueueNewInput(ptr(asbd), cb.ptr, null, null, null, 0, ptr(queueOut));
  if (err !== 0) {
    cb.close();
    throw new Error(`the microphone can't be opened (CoreAudio ${err})`);
  }
  queue = Number(queueOut[0]) as Pointer;
  for (let i = 0; i < BUFFERS; i++) {
    const bufOut = new BigUint64Array(1);
    if (AT.AudioQueueAllocateBuffer(queue, BUFFER_BYTES, ptr(bufOut)) !== 0) throw new Error("CoreAudio gave no buffer");
    AT.AudioQueueEnqueueBuffer(queue, Number(bufOut[0]) as Pointer, 0, null);
  }
  const started = AT.AudioQueueStart(queue, null);
  if (started !== 0) throw new Error(`the microphone can't be started (CoreAudio ${started})`);
  return () => {
    if (queue !== null) AT.AudioQueueStop(queue, true);
    queue = null;
    cb.close();
  };
}
