import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/** Keys of the kv table that hold a connection to other PCs, phones, the account service or secrets. */
const OUTSIDE = /^(account|api_|mesh_|net_|phones_seen|remote_devices|secret_|ctx_|owner_|reload_state|share_files|settings_sync|sync_)/;

/** Copies `from` into `to` (which must not exist yet); the source is only ever read. */
export function copyDb(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`${to} exists already`);
  const src = new Database(from, { readonly: true });
  try {
    src.query("VACUUM INTO ?1").run(to);
  } finally {
    src.close();
  }
  const db = new Database(to);
  try {
    // Every chat starts a new agent session: a resumed one would add turns to the real app's.
    db.exec("UPDATE chats SET started=0, session_id=lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))");
    const keys = db.query("SELECT k FROM kv").all() as { k: string }[];
    const drop = db.query("DELETE FROM kv WHERE k=?1");
    for (const { k } of keys) if (OUTSIDE.test(k)) drop.run(k);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) throw new Error("copydb FROM TO");
  copyDb(from, to);
}
