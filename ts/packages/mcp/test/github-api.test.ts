import "./sandbox.ts";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Shared, newPeer } from "@harbor/net";
import { createGhApi } from "../src/github/api.ts";

const graphql = JSON.stringify({ data: { viewer: { login: "ann" }, authored: { nodes: [] }, reviewing: { nodes: [] }, p0: { nodes: [] } } });

test("the wired GhApi lists pull requests through gh and answers 400 to a bad address", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hghapi-"));
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh\necho "$*" >> "${bin}/log"\ncat <<'EOF'\n${graphql}\nEOF\n`);
  chmodSync(gh, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved ?? ""}`;
  try {
    const shared = new Shared();
    shared.peers.set("p", newPeer({ id: "p", name: "Laptop", addr: "127.0.0.1:1", online: true }));
    const api = createGhApi({
      shared,
      mesh: { forward: async () => ({ status: 200, body: {} }) },
      host: { repos: async () => ["o/r"], projects: async () => [], projectOf: () => undefined, agentLabel: () => "Claude", ctx: () => null, agentThread: async () => ({ status: 500, body: null }) },
      blocks: (md) => [{ t: "p", md }],
      deviceId: () => "dev",
    });
    const r = await api.handle({ method: "GET", path: ["v1", "prs"], query: [], body: null, token: "", device: "", global: false });
    expect(r.status).toBe(200);
    expect((r.body as { viewer: string }).viewer).toBe("ann");
    const bad = await api.handle({ method: "GET", path: ["v1", "prs", "view"], query: [["url", "https://example.com/x"]], body: null, token: "", device: "", global: false });
    expect(bad.status).toBe(400);
  } finally {
    process.env.PATH = saved;
  }
});
