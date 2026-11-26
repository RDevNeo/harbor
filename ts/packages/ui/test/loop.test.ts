import { expect, test } from "bun:test";
import { libc } from "@harbor/os";
import { isDisplaySocket, PACED_IDLE_MAX_MS, PACED_IDLE_MS, pacedIdleMs, pickBackend } from "../src/loop.ts";

test("the paced loop's idle wait follows what an idle turn costs: cheap turns often, costly ones less", () => {
  // Cheap empty turns (Windows, a quick backend): the shortest wait, input feels instant.
  expect(pacedIdleMs(0.05)).toBe(PACED_IDLE_MS);
  // macOS: AppKit's loop makes an empty turn ~1.5 ms; at ~1 % of a core that's the longest wait.
  expect(pacedIdleMs(1.5)).toBe(PACED_IDLE_MAX_MS);
  expect(pacedIdleMs(0.5)).toBe(50);
  expect(pacedIdleMs(40)).toBe(PACED_IDLE_MAX_MS);
});

test("the window's loop waits on the epoll that watches the display's socket, not accesskit's D-Bus one", () => {
  const sockets = new Map([
    [9, [8]],
    [83, [82, 100]],
  ]);
  const peers = new Map<number, string>([
    [8, "/run/user/1000/wayland-1"],
    [82, "/run/user/1000/bus"],
    [100, "/run/user/1000/bus"],
  ]);
  const peer = (fd: number) => peers.get(fd) ?? null;
  const of = (ep: number) => sockets.get(ep) ?? [];
  expect(pickBackend([83, 9], of, peer)).toBe(9);
  // One new epoll: that one, as before.
  expect(pickBackend([83], of, peer)).toBe(83);
  // X11, an abstract socket.
  peers.set(8, "@/tmp/.X11-unix/X0");
  expect(pickBackend([9, 83], of, peer)).toBe(9);
  // Can't tell (no display socket, or two): a paced loop.
  peers.set(8, "/run/user/1000/bus");
  expect(pickBackend([9, 83], of, peer)).toBe(null);
  expect(isDisplaySocket("/run/user/1000/wayland-0")).toBe(true);
  expect(isDisplaySocket("/run/user/1000/bus")).toBe(false);
  expect(isDisplaySocket(null)).toBe(false);
});

test.skipIf(process.platform !== "linux")("peerPath names the path a Unix socket's other end listens on", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const net = await import("node:net");
  const dir = mkdtempSync(join(tmpdir(), "hts-peer-"));
  const path = join(dir, "wayland-9");
  const server = net.createServer(() => {});
  await new Promise<void>((r) => server.listen(path, r));
  const client = net.connect(path);
  await new Promise<void>((r) => client.on("connect", () => r()));
  const fd = (client as unknown as { _handle?: { fd?: number } })._handle?.fd ?? -1;
  if (fd >= 0) expect(libc.peerPath(fd)).toBe(path);
  expect(libc.peerPath(0)).toBe(null);
  client.destroy();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
