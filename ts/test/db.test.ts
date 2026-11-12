import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { items, liveDb, openCopy, sidebar } from "../proto/db.ts";

const dir = mkdtempSync(join(tmpdir(), "hts-db-"));
const path = join(dir, "copy.db");

const seed = new Database(path);
seed.run(`CREATE TABLE repos(id INTEGER PRIMARY KEY, path TEXT, name TEXT, sort INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE chats(id INTEGER PRIMARY KEY, repo_id INTEGER, title TEXT, settled INTEGER NOT NULL DEFAULT 0, parent INTEGER, updated INTEGER);
  CREATE TABLE items(chat_id INTEGER, seq INTEGER, body TEXT, PRIMARY KEY(chat_id, seq));
  INSERT INTO repos VALUES(1,'/a','beta',1),(2,'/b','alpha',0);
  INSERT INTO chats VALUES(10,1,'old',0,NULL,1),(11,1,'new',0,NULL,2),(12,1,'settled',1,NULL,3),(13,1,'sub',0,11,4),(14,2,'other',0,NULL,5),(15,NULL,'loose',0,NULL,6);
  INSERT INTO items VALUES(11,1,'{"kind":"text","text":"second"}'),(11,0,'{"kind":"user","text":"first"}'),(11,2,'{"kind":"thinking","text":""}'),(11,3,'broken');`);
seed.close();

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("db", () => {
  test("the sidebar follows the projects' order, newest chat first, without settled chats and sub-agents", () => {
    const db = openCopy(path);
    expect(sidebar(db).map((r) => `${r.project ? "#" : ""}${r.title}`)).toEqual(["#alpha", "other", "#beta", "new", "old", "#No project", "loose"]);
    db.close();
  });

  test("items come in order; what can't be read or shown is left out", () => {
    const db = openCopy(path);
    expect(items(db, 11).map((i) => i.kind)).toEqual(["user", "text"]);
    db.close();
  });

  test("the copy can't be written", () => {
    const db = openCopy(path);
    expect(() => db.run("DELETE FROM items")).toThrow();
    db.close();
  });

  test("the live database is refused", () => {
    expect(() => openCopy(liveDb())).toThrow("refusing");
  });

  test("the live path follows XDG_DATA_HOME", () => {
    expect(liveDb({ XDG_DATA_HOME: "/x", HOME: "/h" })).toBe(join("/x", "harbor", "harbor.db"));
    expect(liveDb({ HOME: "/h" })).toBe(join("/h", ".local", "share", "harbor", "harbor.db"));
  });
});
