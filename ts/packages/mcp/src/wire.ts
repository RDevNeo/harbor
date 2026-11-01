import { integrate } from "./apps.ts";
import * as discord from "./discord.ts";
import * as gmail from "./gmail.ts";

integrate({
  profileEmail: (token) => gmail.profileEmail(token),
  discord: { signedIn: () => discord.signedIn(), accountName: () => discord.accountName(), signOut: () => discord.signOut(), login: (signal, update) => discord.login(signal, update) },
});
