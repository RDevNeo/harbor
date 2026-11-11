import { expect, test } from "bun:test";
import { type Rows, syncRows } from "../src/modelsync.ts";

/** An ArrayModel that notes what it was told. */
function model(rows: string[]): Rows<string> & { rows: string[]; log: string[] } {
  const log: string[] = [];
  return {
    rows,
    log,
    get length() {
      return rows.length;
    },
    rowData: (i) => rows[i],
    setRowData: (i, v) => {
      rows[i] = v;
      log.push(`set ${i}`);
    },
    remove: (i, n) => {
      rows.splice(i, n);
      log.push(`remove ${i} ${n}`);
    },
    splice: (i, del, ...add) => {
      rows.splice(i, del, ...add);
      log.push(`insert ${i} ${add.length}`);
    },
  };
}

test("rows that come in above the others are put in: the ones below aren't set again", () => {
  const m = model(["top", "more", "c8", "c9", "c10", "end"]);
  syncRows(m, ["top", "c1", "c2", "c3", "c8", "c9", "c10", "end"]);
  expect(m.rows).toEqual(["top", "c1", "c2", "c3", "c8", "c9", "c10", "end"]);
  expect(m.log).toEqual(["set 1", "insert 2 2"]);
});

test("a row in the middle, one taken out, one added at the end, one changed", () => {
  const m = model(["a", "b", "c", "d"]);
  syncRows(m, ["a", "x", "b", "c", "d"]);
  expect(m.log).toEqual(["insert 1 1"]);
  m.log.length = 0;
  syncRows(m, ["a", "b", "c", "d"]);
  expect(m.log).toEqual(["remove 1 1"]);
  m.log.length = 0;
  syncRows(m, ["a", "b", "c", "d", "e"]);
  expect(m.log).toEqual(["insert 4 1"]);
  m.log.length = 0;
  syncRows(m, ["a", "b", "C", "d", "e"]);
  expect(m.log).toEqual(["set 2"]);
  expect(m.rows).toEqual(["a", "b", "C", "d", "e"]);
});

test("another list altogether: its rows take the places there are, then the rest come or go", () => {
  const m = model(["s", "a", "b", "c", "e"]);
  syncRows(m, ["s", "x", "y", "e"]);
  expect(m.rows).toEqual(["s", "x", "y", "e"]);
  expect(m.log).toEqual(["set 1", "set 2", "remove 3 1"]);
  m.log.length = 0;
  syncRows(m, ["s", "p", "q", "r", "t", "e"]);
  expect(m.rows).toEqual(["s", "p", "q", "r", "t", "e"]);
  expect(m.log).toEqual(["set 1", "set 2", "insert 3 2"]);
  m.log.length = 0;
  syncRows(m, []);
  expect(m.rows).toEqual([]);
  syncRows(m, ["a"]);
  expect(m.rows).toEqual(["a"]);
});

test("the same rows by the given likeness are left alone", () => {
  const m = model(["A", "b"]);
  syncRows(m, ["a", "b"], (x, y) => x.toLowerCase() === y.toLowerCase());
  expect(m.log).toEqual([]);
  expect(m.rows).toEqual(["A", "b"]);
});
