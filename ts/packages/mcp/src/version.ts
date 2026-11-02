let current = "0.0.0";

/** The Harbor version MCP servers announce; set once at startup by the app. */
export function setHarborVersion(v: string): void {
  current = v;
}

export function harborVersion(): string {
  return current;
}
