import "./wire.ts";
import * as discord from "./discord.ts";
import * as discordhost from "./discordhost.ts";
import * as discordrepair from "./discordrepair.ts";
import * as discordsetup from "./discordsetup.ts";
import * as gmail from "./gmail.ts";
import { harborVersion } from "./version.ts";

/** `harbor app <name>`: serves one of Harbor's own app servers on stdio. */
export async function serve(args: string[]): Promise<number> {
  discordsetup.configure({ version: harborVersion });
  switch (args[0]) {
    case gmail.NAME:
      await gmail.run({ auth: gmail.harborAuth(), version: harborVersion() });
      return 0;
    case discord.NAME:
      await discord.run();
      return 0;
    case discord.HOST:
      return discordhost.run();
    case discord.REPAIR:
      await discordrepair.run();
      return 0;
    default:
      console.error("harbor app: unknown app");
      return 2;
  }
}
