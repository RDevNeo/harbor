// Windows' microphone through winmm's waveIn (bun:ffi): 16 kHz mono signed 16-bit, as pw-record gives it
// on Linux. Runs in its own process (`harbor record-mic`), which polls its buffers every 20 ms and writes
// each filled one to stdout: no callbacks from Windows' audio thread into JavaScript.
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";

const P = FFIType.ptr;
const U32 = FFIType.u32;
const winmm = dlopen("winmm.dll", {
  waveInOpen: { args: [P, U32, P, P, P, U32], returns: U32 },
  waveInPrepareHeader: { args: [P, P, U32], returns: U32 },
  waveInUnprepareHeader: { args: [P, P, U32], returns: U32 },
  waveInAddBuffer: { args: [P, P, U32], returns: U32 },
  waveInStart: { args: [P], returns: U32 },
  waveInReset: { args: [P], returns: U32 },
  waveInClose: { args: [P], returns: U32 },
}).symbols;

export const RATE = 16_000;
const WAVE_MAPPER = 0xffffffff;
const WHDR_DONE = 1;
/** WAVEHDR (x64): lpData, dwBufferLength @8, dwBytesRecorded @12, dwUser @16, dwFlags @24, …; 48 bytes. */
const HDR = 48;
const BUFFER_BYTES = (RATE / 10) * 2;
const BUFFERS = 4;

/** WAVEFORMATEX for 16 kHz mono signed 16-bit PCM. */
export function format(): Uint8Array {
  const b = Buffer.alloc(18);
  b.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
  b.writeUInt16LE(1, 2);
  b.writeUInt32LE(RATE, 4);
  b.writeUInt32LE(RATE * 2, 8);
  b.writeUInt16LE(2, 12);
  b.writeUInt16LE(16, 14);
  return new Uint8Array(b);
}

/** Records until `stop` is called: each buffer's samples go to `sink`. Throws when there's no microphone or Windows said no. */
export function record(sink: (samples: Uint8Array) => void): () => void {
  const fmt = format();
  const handle = new BigUint64Array(1);
  const err = winmm.waveInOpen(ptr(handle), WAVE_MAPPER, ptr(fmt), null, null, 0);
  // MMSYSERR_BADDEVICEID / MMSYSERR_NODRIVER: no microphone at all; else most often Windows' privacy switch.
  if (err === 2 || err === 6) throw new Error(`no microphone found (waveIn ${err})`);
  if (err !== 0) throw new Error(`the microphone can't be opened (waveIn ${err}); Windows Settings > Privacy > Microphone may keep desktop apps from it`);
  const h = Number(handle[0]) as Pointer;
  const bufs: { data: Uint8Array; hdr: Uint8Array; view: DataView }[] = [];
  for (let i = 0; i < BUFFERS; i++) {
    const data = new Uint8Array(new ArrayBuffer(BUFFER_BYTES));
    const hdr = new Uint8Array(new ArrayBuffer(HDR));
    const view = new DataView(hdr.buffer);
    view.setBigUint64(0, BigInt(ptr(data)), true);
    view.setUint32(8, BUFFER_BYTES, true);
    winmm.waveInPrepareHeader(h, ptr(hdr), HDR);
    winmm.waveInAddBuffer(h, ptr(hdr), HDR);
    bufs.push({ data, hdr, view });
  }
  const started = winmm.waveInStart(h);
  if (started !== 0) {
    winmm.waveInClose(h);
    throw new Error(`the microphone can't be started (waveIn ${started})`);
  }
  let next = 0;
  const timer = setInterval(() => {
    // Buffers fill in the order they were added: take each done one, then give it back.
    for (let n = 0; n < BUFFERS; n++) {
      const b = bufs[next];
      if (b === undefined || (b.view.getUint32(24, true) & WHDR_DONE) === 0) break;
      const got = b.view.getUint32(12, true);
      if (got > 0) sink(b.data.slice(0, got));
      b.view.setUint32(24, b.view.getUint32(24, true) & ~WHDR_DONE, true);
      winmm.waveInAddBuffer(h, ptr(b.hdr), HDR);
      next = (next + 1) % BUFFERS;
    }
  }, 20);
  return () => {
    clearInterval(timer);
    winmm.waveInReset(h);
    for (const b of bufs) winmm.waveInUnprepareHeader(h, ptr(b.hdr), HDR);
    winmm.waveInClose(h);
  };
}
