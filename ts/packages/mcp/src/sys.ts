import { git } from "@harbor/agents";

let opener: (url: string) => void = git.openUrl;

export function openUrl(url: string): void {
  opener(url);
}

export function setOpener(f: (url: string) => void): void {
  opener = f;
}

export function selfExe(env: Record<string, string | undefined> = process.env): string {
  return (env.HARBOR_EXE || process.execPath).replace(/ \(deleted\)$/, "");
}
