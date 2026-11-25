// The tabs besides Projects, window side. One line each: a tab's own files are its owner's.
import type { TabUi } from "./api.ts";
import { personsUi } from "./persons/ui.ts";
import { routineUi } from "./routine/ui.ts";

export const TAB_UIS: TabUi[] = [personsUi, routineUi];
export type { TabCtx, TabUi, TabReply } from "./api.ts";
