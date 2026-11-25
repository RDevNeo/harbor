// The tabs besides Projects, in the tab bar's order. One line each: a tab's own files are its owner's.
import type { TabEngine } from "./api.ts";
import { personsEngine } from "./persons/engine.ts";
import { routineEngine } from "./routine/engine.ts";

export const TAB_ENGINES: TabEngine[] = [personsEngine, routineEngine];
