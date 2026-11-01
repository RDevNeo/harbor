import "./wire.ts";
import * as gmail from "./gmail.ts";

/** `harbor app <name>`: serves one of Harbor's own app servers on stdio. */
export async function serve(args: string[]): Promise<number> {
  switch (args[0]) {
    case gmail.NAME:
      await gmail.run();
      return 0;
    default:
      console.error("harbor app: unknown app");
      return 2;
  }
}
