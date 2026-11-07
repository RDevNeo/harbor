import "./wire.ts";
import { providers } from "@harbor/agents";
import * as discord from "./discord.ts";
import * as discordhost from "./discordhost.ts";
import * as discordrepair from "./discordrepair.ts";
import * as discordsetup from "./discordsetup.ts";
import * as gmail from "./gmail.ts";
import * as whatsapp from "./whatsapp.ts";
import * as whatsapphost from "./whatsapphost.ts";
import { harborVersion } from "./version.ts";

/** The Claude Code login Discord's repair runs on: the main one first, as discordrepair.rs did. */
export function repairAccount(): discordsetup.ClaudeAccount | undefined {
  const usable = providers.discover().filter((a) => a.kind === "Claude" && providers.signedIn(a));
  const a = usable.find((x) => x.id === "claude") ?? usable[0];
  return a === undefined ? undefined : { bin: providers.binStr(a), env: providers.accountEnv(a) };
}

/** `harbor app <name>`: serves one of Harbor's own app servers on stdio. */
export async function serve(args: string[], build: { version?: string; shellRef?: string | undefined; bundle?: string | undefined } = {}): Promise<number> {
  const v = build.version;
  discordsetup.configure({ version: v !== undefined ? () => v : harborVersion, shellRef: () => build.shellRef, bundle: () => build.bundle, claude: repairAccount });
  switch (args[0]) {
    case gmail.NAME:
      await gmail.run({ auth: gmail.harborAuth(), version: v ?? harborVersion() });
      return 0;
    case discord.NAME:
      await discord.run();
      return 0;
    case discord.HOST:
      return discordhost.run();
    case whatsapp.NAME:
      await whatsapp.run(v ?? harborVersion());
      return 0;
    case whatsapp.HOST:
      return whatsapphost.run();
    case discord.REPAIR:
      await discordrepair.run();
      return 0;
    default:
      console.error("harbor app: unknown app");
      return 2;
  }
}
