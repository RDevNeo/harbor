import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Item, parseItem, shown } from "./items.ts";

export interface SideRow {
  id: number;
  project: boolean;
  title: string;
  active: boolean;
}

interface RepoRow {
  id: number;
  name: string;
}

interface ChatRow {
  id: number;
  repo_id: number | null;
  title: string;
}

interface BodyRow {
  body: string;
}

export function liveDb(env: Record<string, string | undefined> = process.env): string {
  const data = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(data, "harbor", "harbor.db");
}

export function openCopy(path: string): Database {
  if (resolve(path) === resolve(liveDb())) {
    throw new Error("refusing to open the live harbor.db: pass a copy");
  }
  const db = new Database(path, { readonly: true });
  db.run("PRAGMA query_only=ON");
  return db;
}

export function sidebar(db: Database): SideRow[] {
  const repos = db.query<RepoRow, []>("SELECT id, name FROM repos ORDER BY sort, name COLLATE NOCASE").all();
  const chats = db
    .query<ChatRow, []>("SELECT id, repo_id, title FROM chats WHERE settled=0 AND parent IS NULL ORDER BY updated DESC")
    .all();
  const rows: SideRow[] = [];
  const group = (id: number, title: string, list: ChatRow[]) => {
    if (list.length === 0) return;
    rows.push({ id, project: true, title, active: false });
    for (const c of list) rows.push({ id: c.id, project: false, title: c.title, active: false });
  };
  for (const r of repos) group(-r.id, r.name, chats.filter((c) => c.repo_id === r.id));
  group(0, "No project", chats.filter((c) => c.repo_id === null));
  return rows;
}

export function items(db: Database, chatId: number): Item[] {
  const rows = db.query<BodyRow, [number]>("SELECT body FROM items WHERE chat_id=?1 ORDER BY seq").all(chatId);
  const out: Item[] = [];
  for (const r of rows) {
    const it = parseItem(r.body);
    if (it && shown(it)) out.push(it);
  }
  return out;
}
