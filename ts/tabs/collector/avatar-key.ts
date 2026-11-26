// A picture's cache name (engine) and id (the phone's GET v1/collector/avatar?id=).
import { createHash } from "node:crypto";

export const avatarKey = (url: string): string => createHash("sha1").update(url).digest("hex").slice(0, 20);
