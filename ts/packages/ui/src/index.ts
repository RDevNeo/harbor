import { dataDir, Store } from "@harbor/store";
import { Data } from "./data.ts";
import { run } from "./shell.ts";

export { Data } from "./data.ts";
export { Shell, run as runShell, type ShellHooks } from "./shell.ts";

export async function openWindow(): Promise<number> {
  const store = Store.open(dataDir());
  await run(new Data(store));
  store.close();
  return 0;
}
