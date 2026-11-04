// HARBOR_POINTER, as app.rs `scripted_input`: "x,y[,action[,secs]]" steps joined by ';'.
import type * as slint from "slint-ui";

export interface Step {
  x: number;
  y: number;
  action: string;
  at: number;
}

export function parseSteps(spec: string): Step[] {
  const out: Step[] = [];
  for (const s of spec.split(";")) {
    const parts = s.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (parts.length < 2 || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const secs = parts[3] === undefined ? 1 : Number(parts[3]);
    out.push({ x, y, action: parts[2] ?? "", at: Number.isFinite(secs) ? secs : 1 });
  }
  return out;
}

const KEYS: Record<string, string> = { Return: "\n", Tab: "\t", Escape: "\u{1b}", Up: "\u{f700}", Down: "\u{f701}", Left: "\u{f702}", Right: "\u{f703}", Backspace: "\u{8}", Delete: "\u{7f}" };
const CONTROL = "\u{11}";

function press(w: slint.Window, text: string): void {
  w.dispatchEvent({ type: "key-pressed", text });
  w.dispatchEvent({ type: "key-released", text });
}

export function runStep(w: slint.Window, s: Step): void {
  const position = { x: s.x, y: s.y };
  w.dispatchEvent({ type: "pointer-moved", position });
  const [kind, arg = ""] = s.action.includes(":") ? [s.action.slice(0, s.action.indexOf(":")), s.action.slice(s.action.indexOf(":") + 1)] : [s.action, ""];
  switch (kind) {
    // The pointer only goes there (every step moves it first): a hover.
    case "move":
      break;
    case "click":
    case "rclick": {
      const button = kind === "click" ? "left" : "right";
      w.dispatchEvent({ type: "pointer-pressed", position, button });
      w.dispatchEvent({ type: "pointer-released", position, button });
      break;
    }
    case "down":
      w.dispatchEvent({ type: "pointer-pressed", position, button: "left" });
      break;
    case "up":
      w.dispatchEvent({ type: "pointer-released", position, button: "left" });
      break;
    case "wheel":
    case "wheel-down":
      w.dispatchEvent({ type: "pointer-scrolled", position, deltaX: 0, deltaY: kind === "wheel" ? 120 : -120 });
      break;
    case "type":
      for (const c of arg.replaceAll("_", " ")) press(w, c);
      break;
    case "key":
      press(w, KEYS[arg] ?? arg);
      break;
    case "ctrl":
      w.dispatchEvent({ type: "key-pressed", text: CONTROL });
      press(w, KEYS[arg] ?? arg);
      w.dispatchEvent({ type: "key-released", text: CONTROL });
      break;
  }
}

export function scripted(w: slint.Window, spec: string | undefined): void {
  if (!spec) return;
  for (const s of parseSteps(spec)) setTimeout(() => runStep(w, s), s.at * 1000);
}
