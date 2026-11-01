import { RUNTIME_VERSION, VERSION, updateCommands } from "./packages/update/src/index.ts";

declare const HARBOR_MIN_RUNTIME: string | undefined;

export const meta = { version: VERSION, minRuntime: typeof HARBOR_MIN_RUNTIME === "string" ? HARBOR_MIN_RUNTIME : RUNTIME_VERSION };

const commands = { ...updateCommands };

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const cmd = name === undefined ? undefined : commands[name];
  if (cmd === undefined) {
    console.error(`harbor: ${name === undefined ? "no command given" : `unknown command ${name}`} (this build has: ${Object.keys(commands).join(", ")})`);
    return 2;
  }
  return await cmd(rest);
}
