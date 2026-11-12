import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as creds from "../src/claudecreds.ts";

test("Claude Code's keychain item per profile: the default's, or named after its config folder's hash", () => {
  expect(creds.keychainService(null)).toBe("Claude Code-credentials");
  // As Claude Code names it on macOS: the first 8 hex digits of the folder's SHA-256.
  expect(creds.keychainService("/Users/sam/.claude-work")).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  expect(creds.keychainService("/a")).not.toBe(creds.keychainService("/a/"));
});

test.if(process.platform !== "darwin")("elsewhere the login is the profile's .credentials.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "hcc-"));
  try {
    expect(creds.read(dir)).toBeNull();
    expect(creds.exists(dir)).toBe(false);
    creds.write(dir, '{"claudeAiOauth":{}}\n');
    expect(creds.exists(dir)).toBe(true);
    expect(creds.read(dir)).toBe('{"claudeAiOauth":{}}\n');
    creds.remove(dir);
    expect(creds.exists(dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
