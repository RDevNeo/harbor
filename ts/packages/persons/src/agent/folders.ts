// Discord's server folders as its settings proto keeps them (PreloadedUserSettings, type 1, field 14 GuildFolders):
// just enough protobuf to read the folders and to put new ones in while every other setting stays byte for byte.
//   GuildFolders { repeated GuildFolder folders = 1; repeated fixed64 guild_positions = 2; }
//   GuildFolder  { repeated fixed64 guild_ids = 1; Int64Value id = 2; StringValue name = 3; UInt64Value color = 4; }
// A "folder" without an id holding one server is a server on its own at the top of the sidebar.

export interface Folder {
  guildIds: string[];
  /** null: not a real folder (a single server at the top level). */
  id: string | null;
  name: string | null;
  color: number | null;
}

interface Field {
  no: number;
  wire: number;
  /** The whole field, tag included (kept as is when it isn't touched). */
  raw: Uint8Array;
  /** Wire type 0: the number; 1: the 8 bytes' value; 2: the bytes. */
  num?: bigint;
  bytes?: Uint8Array;
}

function varint(b: Uint8Array, at: number): [bigint, number] {
  let v = 0n;
  let shift = 0n;
  for (let i = at; i < b.length; i++) {
    const x = b[i] as number;
    v |= BigInt(x & 0x7f) << shift;
    if ((x & 0x80) === 0) return [v, i + 1];
    shift += 7n;
    if (shift > 70n) break;
  }
  throw new Error("The settings proto is damaged.");
}

function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  while (at < b.length) {
    const start = at;
    const [tag, next] = varint(b, at);
    at = next;
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    const f: Field = { no, wire, raw: new Uint8Array() };
    if (wire === 0) {
      const [v, n] = varint(b, at);
      f.num = v;
      at = n;
    } else if (wire === 1) {
      if (at + 8 > b.length) throw new Error("The settings proto is damaged.");
      f.num = new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
      at += 8;
    } else if (wire === 2) {
      const [len, n] = varint(b, at);
      const end = n + Number(len);
      if (end > b.length) throw new Error("The settings proto is damaged.");
      f.bytes = b.subarray(n, end);
      at = end;
    } else if (wire === 5) {
      at += 4;
    } else throw new Error("The settings proto is damaged.");
    f.raw = b.subarray(start, at);
    out.push(f);
  }
  return out;
}

function putVarint(out: number[], v: bigint): void {
  let x = v;
  for (;;) {
    const low = Number(x & 0x7fn);
    x >>= 7n;
    if (x === 0n) {
      out.push(low);
      return;
    }
    out.push(low | 0x80);
  }
}

function lenField(no: number, body: Uint8Array | number[]): number[] {
  const out: number[] = [];
  putVarint(out, BigInt((no << 3) | 2));
  putVarint(out, BigInt(body.length));
  for (const x of body) out.push(x);
  return out;
}

function fixed64s(ids: string[]): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(id), true);
    out.push(...b);
  }
  return out;
}

/** The first field 1 (a wrapper type's value) of a small message. */
const wrapped = (b: Uint8Array | undefined): Field | undefined => (b ? fields(b).find((f) => f.no === 1) : undefined);

function readFolder(b: Uint8Array): Folder {
  const f: Folder = { guildIds: [], id: null, name: null, color: null };
  for (const x of fields(b)) {
    if (x.no === 1 && x.wire === 2 && x.bytes) {
      for (let i = 0; i + 8 <= x.bytes.length; i += 8) f.guildIds.push(new DataView(x.bytes.buffer, x.bytes.byteOffset + i, 8).getBigUint64(0, true).toString());
    } else if (x.no === 1 && x.wire === 1 && x.num !== undefined) f.guildIds.push(x.num.toString());
    else if (x.no === 2) {
      const v = wrapped(x.bytes);
      f.id = v?.num !== undefined ? BigInt.asIntN(64, v.num).toString() : "0";
    } else if (x.no === 3) {
      const v = wrapped(x.bytes);
      f.name = v?.bytes ? new TextDecoder().decode(v.bytes) : "";
    } else if (x.no === 4) {
      const v = wrapped(x.bytes);
      f.color = v?.num !== undefined ? Number(v.num) : 0;
    }
  }
  return f;
}

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** The folders in a settings proto (base64), in sidebar order; [] when it has none. */
export function readFolders(proto: string): Folder[] {
  const top = fields(b64(proto)).filter((f) => f.no === 14 && f.wire === 2);
  const out: Folder[] = [];
  for (const g of top) for (const f of fields(g.bytes ?? new Uint8Array())) if (f.no === 1 && f.wire === 2 && f.bytes) out.push(readFolder(f.bytes));
  return out;
}

function writeFolder(f: Folder): number[] {
  const body: number[] = [...lenField(1, fixed64s(f.guildIds))];
  if (f.id !== null) {
    const v: number[] = [8];
    putVarint(v, BigInt.asUintN(64, BigInt(f.id)));
    body.push(...lenField(2, v));
  }
  if (f.name !== null) body.push(...lenField(3, lenField(1, [...new TextEncoder().encode(f.name)])));
  if (f.color !== null) {
    const v: number[] = [8];
    putVarint(v, BigInt(f.color));
    body.push(...lenField(4, v));
  }
  return body;
}

/** The same settings proto with these folders instead (everything else as it was), base64. */
export function withFolders(proto: string, folders: Folder[]): string {
  const top = fields(b64(proto));
  const old = top.find((f) => f.no === 14 && f.wire === 2);
  const keep = old ? fields(old.bytes ?? new Uint8Array()).filter((f) => f.no !== 1) : [];
  const gf: number[] = [];
  for (const f of folders) gf.push(...lenField(1, writeFolder(f)));
  for (const k of keep) gf.push(...k.raw);
  const out: number[] = [];
  let put = false;
  for (const f of top) {
    if (f.no === 14 && f.wire === 2) {
      if (!put) out.push(...lenField(14, gf));
      put = true;
    } else out.push(...f.raw);
  }
  if (!put) out.push(...lenField(14, gf));
  return Buffer.from(new Uint8Array(out)).toString("base64");
}
