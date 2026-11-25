// Persons tab, engine side (owned by the persons port): routes under v1/persons/…, data under <data dir>/persons/.
import type { TabEngine } from "../api.ts";

export const personsEngine: TabEngine = {
  id: "persons",
  route: async () => null,
};
