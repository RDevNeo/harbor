import { writeFileSync } from "node:fs";
import * as discord from "../src/discord.ts";
import * as host from "../src/discordhost.ts";
import * as repair from "../src/discordrepair.ts";

const [, , app, name] = process.argv;
if (app !== "app") process.exit(2);
if (name === discord.REPAIR) {
  await repair.run();
} else if (name === discord.NAME) {
  await discord.run();
} else if (name === discord.HOST) {
  const pidFile = process.env.HARBOR_DISCORD_HOST_PID;
  if (pidFile !== undefined) {
    writeFileSync(pidFile, String(process.pid));
    writeFileSync(`${pidFile}.env`, JSON.stringify(Object.keys(process.env).sort()));
  }
  process.exit(await host.run());
} else {
  process.exit(2);
}
process.exit(0);
