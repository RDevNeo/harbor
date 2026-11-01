import { integrate } from "./apps.ts";
import * as gmail from "./gmail.ts";

integrate({ profileEmail: (token) => gmail.profileEmail(token) });
