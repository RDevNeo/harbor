import { readFileSync } from "node:fs";
import type { Item } from "@harbor/store";
import type { CaptchaCall } from "./chatcaptcha.ts";

/**
 * A captcha with no Discord, for screenshots (scripts/shot --env): HARBOR_FAKE_CAPTCHA=<a PNG> puts a pending
 * captcha notice at the end of every chat shown (in the window only, never stored) and answers its frames
 * from that image. HARBOR_FAKE_CAPTCHA_SOLVER=<name>: another PC holds it ("Being solved on <name>").
 * HARBOR_FAKE_CAPTCHA_STATE=joined|closed|timeout|stopped: it has ended (the outcome line). The captcha is
 * HARBOR_FAKE_CAPTCHA_RECT=x,y,w,h of the image (default: its middle 40% by 80%).
 */
export interface FakeCaptcha {
  items(base: readonly Item[]): Item[];
  call: CaptchaCall;
}

const ID = "fake-captcha";
const GUILD = "Example Server";
const ENDS: Record<string, string> = {
  joined: `Captcha solved: joined ${GUILD}`,
  closed: `Captcha closed: ${GUILD} wasn't joined`,
  timeout: `Nobody solved the captcha in time: ${GUILD} wasn't joined`,
  stopped: `Discord stopped before the captcha was solved: ${GUILD} wasn't joined`,
};

/** A PNG's size from its header. */
export function pngSize(b: Uint8Array): [number, number] | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

export function fakeCaptcha(env: Record<string, string | undefined> = process.env): FakeCaptcha | null {
  const path = env.HARBOR_FAKE_CAPTCHA;
  if (!path) return null;
  const bytes = readFileSync(path);
  const [width, height] = pngSize(bytes) ?? [960, 600];
  const data = bytes.toString("base64");
  const state = env.HARBOR_FAKE_CAPTCHA_STATE ?? "pending";
  const solver = env.HARBOR_FAKE_CAPTCHA_SOLVER ? { who: "pc:fake-other", label: env.HARBOR_FAKE_CAPTCHA_SOLVER } : null;
  const r = (env.HARBOR_FAKE_CAPTCHA_RECT ?? "").split(",").map(Number);
  const rect = r.length === 4 && r.every((n) => Number.isFinite(n)) ? { x: r[0] ?? 0, y: r[1] ?? 0, width: r[2] ?? 0, height: r[3] ?? 0 } : { x: Math.round(width * 0.3), y: Math.round(height * 0.1), width: Math.round(width * 0.4), height: Math.round(height * 0.8) };
  const note = (s: string, text: string): Item => ({ kind: "notice", icon: "captcha", text, detail: JSON.stringify({ captcha: ID, state: s, guild: GUILD }) });
  const notes = [note("pending", `Discord needs a captcha to join ${GUILD}`), ...(ENDS[state] ? [note(state, ENDS[state])] : [])];
  let open = notes.length === 1;
  return {
    items: (base) => [...base, ...notes],
    call: async (_c, body) => {
      switch (body.action) {
        case "frame":
          return open ? { status: 200, body: { captcha: ID, guild: GUILD, data, width, height, crop: { x: 0, y: 0, width, height }, rect, solver } } : { status: 404, body: { error: "no captcha waits" } };
        case "input":
          return { status: 200, body: { taken: solver === null, solver: solver ?? { who: body.who, label: body.label } } };
        case "cancel":
          open = false;
          return { status: 200, body: {} };
        default:
          return { status: 400, body: { error: "unknown action" } };
      }
    },
  };
}
