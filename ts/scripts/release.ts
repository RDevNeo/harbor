import { releaseCli } from "../packages/update/src/release-cli.ts";

process.exit(await releaseCli(process.argv.slice(2)));
