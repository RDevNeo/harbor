export type Platform = "linux" | "darwin" | "win32" | "other";

/** The OS Harbor runs on. HARBOR_TEST_PLATFORM stands in for another in tests. */
export function platform(env: Record<string, string | undefined> = process.env): Platform {
  const p = env.HARBOR_TEST_PLATFORM || process.platform;
  return p === "linux" || p === "darwin" || p === "win32" ? p : "other";
}
