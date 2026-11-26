// The connection kinds this build has: Discord, Gmail and WhatsApp (Person Hub's three), and Instagram (Personal).
import type { ChannelKind } from "../model/types.ts";
import { createDiscord } from "./discord.ts";
import { createGmail } from "./gmail.ts";
import { createInstagram } from "./instagram.ts";
import type { ConnFactory } from "./types.ts";
import { createWhatsapp } from "./whatsapp.ts";

export const FACTORIES: Partial<Record<ChannelKind, ConnFactory>> = {
  discord: (ctx) => createDiscord(ctx),
  gmail: (ctx) => createGmail(ctx),
  whatsapp: (ctx) => createWhatsapp(ctx),
  instagram: (ctx) => createInstagram(ctx),
};
