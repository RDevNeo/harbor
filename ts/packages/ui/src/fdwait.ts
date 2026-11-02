// A Worker for loop.ts: blocks in poll(2) on the window backend's epoll fd, without reading from it, and posts
// once it is readable. Each message from the window's thread (the fd) arms one wait.
import { dlopen, FFIType, ptr } from "bun:ffi";

declare const self: Worker;

const POLLIN = 1;
const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
});
const pollfd = new DataView(new ArrayBuffer(8));

self.onmessage = (e: MessageEvent<number>) => {
  pollfd.setInt32(0, e.data, true);
  pollfd.setInt16(4, POLLIN, true);
  pollfd.setInt16(6, 0, true);
  let n = -1;
  for (let tries = 0; n < 0 && tries < 100; tries++) n = libc.symbols.poll(ptr(pollfd), 1, -1);
  self.postMessage(n);
};
