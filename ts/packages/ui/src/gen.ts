import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { iconsSlint } from "./icons.ts";
import { themeSlint } from "./theme.ts";

const dir = join(import.meta.dir, "../slint");
writeFileSync(join(dir, "theme.slint"), themeSlint());
writeFileSync(join(dir, "icons.slint"), iconsSlint());
