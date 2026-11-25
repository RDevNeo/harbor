import { integrate } from "./apps.ts";
import * as discord from "./discord.ts";
import * as gmail from "./gmail.ts";
import * as whatsapp from "./whatsapp.ts";

integrate({
  profileEmail: (token) => gmail.profileEmail(token),
  // Discord is Persons' connection (discord.ts `provide`): turns get the tools while it exists, signed in or not.
  discord: { signedIn: () => discord.signedIn(), available: () => discord.available(), accountName: () => discord.accountName(), signOut: () => discord.signOut(), login: (signal, update) => discord.login(signal, update) },
  whatsapp: {
    signedIn: () => whatsapp.signedIn(),
    accountName: () => whatsapp.accountName(),
    signOut: () => whatsapp.signOut(),
    login: (signal, update) => whatsapp.login(signal, update),
  },
});
