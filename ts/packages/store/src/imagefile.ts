import { basename } from "node:path";
const EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

/** Whether `path`'s extension is an image's (any case). */
export function isImage(path: string): boolean {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  // A leading dot names the file (".png" has no extension), as Rust's `Path::extension` reads it.
  if (dot <= 0) return false;
  return EXTS.includes(name.slice(dot + 1).toLowerCase());
}
