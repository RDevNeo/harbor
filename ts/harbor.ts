// `harbor <command>`: the command-line entry points agents and helper processes call. Each
// package adds its own command here.
import { runTurn } from "./packages/agents/src/index.ts";

type Command = (args: string[]) => Promise<number> | number;

const commands: Record<string, Command> = {
  turn: async (args) => {
    await runTurn(args);
    return 0;
  },
};

const [name, ...rest] = process.argv.slice(2);
const cmd = name === undefined ? undefined : commands[name];
if (cmd === undefined) {
  console.error(`harbor: ${name === undefined ? "no command given" : `unknown command ${name}`} (this build has: ${Object.keys(commands).join(", ")})`);
  process.exit(2);
}
process.exit(await cmd(rest));
