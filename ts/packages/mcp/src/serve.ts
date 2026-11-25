import "./wire.ts";
import * as appsetup from "./appsetup.ts";
import * as discord from "./discord.ts";
import * as gmail from "./gmail.ts";
import * as whatsapp from "./whatsapp.ts";
import * as whatsapphost from "./whatsapphost.ts";
import { harborVersion } from "./version.ts";

/** `harbor app <name>`: serves one of Harbor's own app servers on stdio. */
export async function serve(args: string[], build: { version?: string; buildRef?: string | undefined; bundle?: string | undefined } = {}): Promise<number> {
  const v = build.version;
  appsetup.configure({ version: v !== undefined ? () => v : harborVersion, buildRef: () => build.buildRef, bundle: () => build.bundle });
  switch (args[0]) {
    case gmail.NAME:
      await gmail.run({ auth: gmail.harborAuth(), version: v ?? harborVersion() });
      return 0;
    case discord.NAME:
      await discord.run();
      return 0;
    case whatsapp.NAME:
      await whatsapp.run(v ?? harborVersion());
      return 0;
    case whatsapp.HOST:
      return whatsapphost.run();
    default:
      console.error("harbor app: unknown app");
      return 2;
  }
}
