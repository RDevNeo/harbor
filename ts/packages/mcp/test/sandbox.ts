import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harbor-mcp-sandbox-"));
process.env.HOME = join(root, "home");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.XDG_RUNTIME_DIR = join(root, "run");
mkdirSync(process.env.HOME, { recursive: true });
