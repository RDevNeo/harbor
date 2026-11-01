// In a `bun build --compile` executable these imports aren't files on disk: they are written out
// once, to a folder named by their hash, and loaded from there (from source too).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import geistMedium from "../../../../assets/fonts/Geist-Medium.ttf" with { type: "file" };
import geistRegular from "../../../../assets/fonts/Geist-Regular.ttf" with { type: "file" };
import geistSemibold from "../../../../assets/fonts/Geist-SemiBold.ttf" with { type: "file" };
import geistMono from "../../../../assets/fonts/GeistMono-Regular.ttf" with { type: "file" };
import lucide from "../../../../assets/fonts/lucide.ttf" with { type: "file" };
import addproject from "../slint/addproject.slint" with { type: "file" };
import app from "../slint/app.slint" with { type: "file" };
import chat from "../slint/chat.slint" with { type: "file" };
import composer from "../slint/composer.slint" with { type: "file" };
import devices from "../slint/devices.slint" with { type: "file" };
import files from "../slint/files.slint" with { type: "file" };
import gallery from "../slint/gallery.slint" with { type: "file" };
import icons from "../slint/icons.slint" with { type: "file" };
import issuedetail from "../slint/issuedetail.slint" with { type: "file" };
import issues from "../slint/issues.slint" with { type: "file" };
import lightbox from "../slint/lightbox.slint" with { type: "file" };
import listdetail from "../slint/listdetail.slint" with { type: "file" };
import markdown from "../slint/markdown.slint" with { type: "file" };
import palette from "../slint/palette.slint" with { type: "file" };
import picker from "../slint/picker.slint" with { type: "file" };
import prdetail from "../slint/prdetail.slint" with { type: "file" };
import prs from "../slint/prs.slint" with { type: "file" };
import settings from "../slint/settings.slint" with { type: "file" };
import settingsAppearance from "../slint/settings-appearance.slint" with { type: "file" };
import settingsBlocks from "../slint/settings-blocks.slint" with { type: "file" };
import settingsIntegrations from "../slint/settings-integrations.slint" with { type: "file" };
import settingsKeybindings from "../slint/settings-keybindings.slint" with { type: "file" };
import settingsNotifications from "../slint/settings-notifications.slint" with { type: "file" };
import settingsProviders from "../slint/settings-providers.slint" with { type: "file" };
import settingsRows from "../slint/settings-rows.slint" with { type: "file" };
import settingsUsage from "../slint/settings-usage.slint" with { type: "file" };
import settingsVoice from "../slint/settings-voice.slint" with { type: "file" };
import settingsWebhooks from "../slint/settings-webhooks.slint" with { type: "file" };
import sidebar from "../slint/sidebar.slint" with { type: "file" };
import surface from "../slint/surface.slint" with { type: "file" };
import team from "../slint/team.slint" with { type: "file" };
import terminal from "../slint/terminal.slint" with { type: "file" };
import theme from "../slint/theme.slint" with { type: "file" };
import widgets from "../slint/widgets.slint" with { type: "file" };

export const FILES: Readonly<Record<string, string>> = {
  "addproject.slint": addproject,
  "app.slint": app,
  "chat.slint": chat,
  "composer.slint": composer,
  "gallery.slint": gallery,
  "icons.slint": icons,
  "issuedetail.slint": issuedetail,
  "issues.slint": issues,
  "lightbox.slint": lightbox,
  "listdetail.slint": listdetail,
  "markdown.slint": markdown,
  "palette.slint": palette,
  "picker.slint": picker,
  "prdetail.slint": prdetail,
  "prs.slint": prs,
  "settings-appearance.slint": settingsAppearance,
  "settings-blocks.slint": settingsBlocks,
  "settings-integrations.slint": settingsIntegrations,
  "settings-keybindings.slint": settingsKeybindings,
  "settings-notifications.slint": settingsNotifications,
  "settings-providers.slint": settingsProviders,
  "settings-rows.slint": settingsRows,
  "settings-usage.slint": settingsUsage,
  "settings-voice.slint": settingsVoice,
  "settings-webhooks.slint": settingsWebhooks,
  "settings.slint": settings,
  "sidebar.slint": sidebar,
  "surface.slint": surface,
  "devices.slint": devices,
  "files.slint": files,
  "team.slint": team,
  "terminal.slint": terminal,
  "theme.slint": theme,
  "widgets.slint": widgets,
  "fonts/Geist-Regular.ttf": geistRegular,
  "fonts/Geist-Medium.ttf": geistMedium,
  "fonts/Geist-SemiBold.ttf": geistSemibold,
  "fonts/GeistMono-Regular.ttf": geistMono,
  "fonts/lucide.ttf": lucide,
};

function base(env: Record<string, string | undefined>): string {
  return env.XDG_RUNTIME_DIR && existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : tmpdir();
}

export async function uiDir(env: Record<string, string | undefined> = process.env): Promise<string> {
  const blobs: [string, Uint8Array][] = [];
  const h = createHash("sha256");
  for (const [name, path] of Object.entries(FILES)) {
    const b = await Bun.file(path).bytes();
    blobs.push([name, b]);
    h.update(name).update(b);
  }
  const dir = join(base(env), `harbor-ui-${h.digest("hex").slice(0, 16)}`);
  if (existsSync(join(dir, ".complete"))) return dir;
  const tmp = `${dir}.${process.pid}`;
  mkdirSync(join(tmp, "fonts"), { recursive: true, mode: 0o700 });
  for (const [name, b] of blobs) writeFileSync(join(tmp, name), b);
  writeFileSync(join(tmp, ".complete"), "");
  try {
    renameSync(tmp, dir);
  } catch {
    // Another Harbor wrote the same folder first.
  }
  return dir;
}
