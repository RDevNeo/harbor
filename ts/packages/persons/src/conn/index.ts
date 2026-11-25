// The connection kinds this build has (filled in as each backend lands).
import type { ChannelKind } from "../model/types.ts";
import type { ConnFactory } from "./types.ts";

export const FACTORIES: Partial<Record<ChannelKind, ConnFactory>> = {};
