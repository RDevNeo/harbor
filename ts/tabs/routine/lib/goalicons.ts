/** Line icons for goals: goals store the key; each is a Lucide glyph (assets/fonts/lucide.ttf) on the PC and phone. */
export const GOAL_ICON_KEYS = ["activity", "arm", "dumbbell", "droplet", "run", "bike", "flame", "heart", "leaf", "book", "timer", "zap"] as const;
export type GoalIconKey = (typeof GOAL_ICON_KEYS)[number];

export const isGoalIconKey = (v: unknown): v is GoalIconKey => typeof v === "string" && (GOAL_ICON_KEYS as readonly string[]).includes(v);

/** Lucide code points: activity, chevrons-up (arm), dumbbell, droplet, person-standing (run), bike, flame, heart, leaf, book, timer, zap. */
export const GOAL_GLYPH: Record<GoalIconKey, string> = {
  activity: "\u{e038}",
  arm: "\u{e074}",
  dumbbell: "\u{e3a1}",
  droplet: "\u{e0b4}",
  run: "\u{e21e}",
  bike: "\u{e1d2}",
  flame: "\u{e0d2}",
  heart: "\u{e0f2}",
  leaf: "\u{e2de}",
  book: "\u{e05e}",
  timer: "\u{e1e0}",
  zap: "\u{e1b4}",
};

export const goalGlyph = (k: string): string => GOAL_GLYPH[isGoalIconKey(k) ? k : "activity"];
