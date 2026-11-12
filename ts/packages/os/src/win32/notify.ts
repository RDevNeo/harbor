// Windows' notifications (toasts, through WinRT's ToastNotificationManager over bun:ffi), shown as
// Harbor's: Harbor registers its app id under HKCU\Software\Classes\AppUserModelId, as unpackaged apps do.
// A click comes back while Harbor runs (the toast's Activated event). Loaded only on Windows.
import { dlopen, FFIType, JSCallback, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_ID } from "../autostart.ts";
import { code, fn, guid, kernel32, pointer, setRegString } from "./gui.ts";

const P = FFIType.ptr;
const I32 = FFIType.i32;

const combase = (() => {
  let s: ReturnType<typeof open> | undefined;
  const open = () =>
    dlopen("combase.dll", {
      RoInitialize: { args: [FFIType.u32], returns: I32 },
      WindowsCreateString: { args: [P, FFIType.u32, P], returns: I32 },
      WindowsDeleteString: { args: [P], returns: I32 },
      RoGetActivationFactory: { args: [P, P, P], returns: I32 },
      RoActivateInstance: { args: [P, P], returns: I32 },
    }).symbols;
  return () => (s ??= open());
})();

const IID = {
  managerStatics: guid("50AC103F-D235-4598-BBEF-98FE4D1A3AD4"),
  managerStatics2: guid("7AB93C52-0E48-4750-BA9D-1A4113981847"),
  toastFactory: guid("04124B20-82C6-4229-B109-FD9ED4662B53"),
  toast2: guid("9DFB9FD1-143A-490E-90BF-B9FBA7132DE7"),
  xmlDocument: guid("F7F3A506-1E87-42D6-BCFB-B8C809FA5494"),
  xmlDocumentIO: guid("6CD0E74E-EE65-4489-9EBF-CA43E87BA637"),
};
const GROUP = "harbor";

/** HRESULT: fails loudly. */
function ok(hr: unknown, what: string): void {
  if (typeof hr === "number" && hr < 0) throw new Error(`${what} failed (0x${(hr >>> 0).toString(16)})`);
}

/** A WinRT string for the length of `f`. */
function hstring<T>(s: string, f: (h: Pointer | null) => T): T {
  if (s === "") return f(null);
  const out = new BigUint64Array(1);
  const w = Buffer.from(s, "utf16le");
  ok(combase().WindowsCreateString(ptr(w), s.length, ptr(out)), "WindowsCreateString");
  const h = Number(out[0]) as Pointer;
  try {
    return f(h);
  } finally {
    combase().WindowsDeleteString(h);
  }
}

/** Calls the COM method at `slot` of `obj`'s vtable. */
function method(obj: Pointer, slot: number, args: FFIType[], ...values: unknown[]): number {
  const vtbl = read.ptr(obj, 0) as Pointer;
  const at = read.ptr(vtbl, slot * 8) as Pointer;
  return fn(at, [P, ...args], I32)(obj, ...values) as number;
}

const release = (obj: Pointer | null): void => {
  if (obj !== null) method(obj, 2, []);
};

/** `obj` as another of its interfaces; it must be released. */
function as(obj: Pointer, iid: Uint8Array, what: string): Pointer {
  const out = new BigUint64Array(1);
  ok(method(obj, 0, [P, P], ptr(iid), ptr(out)), what);
  return Number(out[0]) as Pointer;
}

/** A method's out pointer, after it ran. */
function out(f: (at: Pointer) => number, what: string): Pointer {
  const o = new BigUint64Array(1);
  ok(f(ptr(o)), what);
  return Number(o[0]) as Pointer;
}

interface Center {
  notifier: Pointer;
  toastFactory: Pointer;
  history: Pointer | null;
}
let center: Center | null = null;

function factory(cls: string, iid: Uint8Array): Pointer {
  return hstring(cls, (h) => out((o) => combase().RoGetActivationFactory(h, ptr(iid), o), `the ${cls} factory`));
}

/** Registers Harbor's app id (its name and icon in the notification) and opens the notifier, once. */
function setUp(): Center {
  if (center !== null) return center;
  // Single-threaded, as Slint's window loop already set COM up on this thread (a mismatch is refused, harmlessly).
  combase().RoInitialize(0);
  const key = `Software\\Classes\\AppUserModelId\\${APP_ID}`;
  setRegString(key, "DisplayName", "Harbor");
  const icon = join(dirname(process.execPath), "harbor.png");
  if (existsSync(icon)) setRegString(key, "IconUri", icon);
  const statics = factory("Windows.UI.Notifications.ToastNotificationManager", IID.managerStatics);
  try {
    const notifier = hstring(APP_ID, (id) => out((o) => method(statics, 7, [P, P], id, o), "CreateToastNotifierWithId"));
    const toastFactory = factory("Windows.UI.Notifications.ToastNotification", IID.toastFactory);
    let history: Pointer | null = null;
    try {
      const s2 = as(statics, IID.managerStatics2, "ToastNotificationManagerStatics2");
      history = out((o) => method(s2, 6, [P], o), "get_History");
      release(s2);
    } catch {
      // Before Windows 10: notes can't be taken back, they still show.
    }
    center = { notifier, toastFactory, history };
    return center;
  } finally {
    release(statics);
  }
}

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The toast's XML: title, body, and silence unless it sounds. */
export function toastXml(title: string, body: string, sound: boolean): string {
  const texts = [title, body].filter((t) => t !== "").map((t) => `<text>${esc(t)}</text>`).join("");
  return `<toast><visual><binding template="ToastGeneric">${texts}</binding></visual>${sound ? "" : '<audio silent="true"/>'}</toast>`;
}

// --- Clicks: a TypedEventHandler<ToastNotification, IInspectable> per clickable note ---

/**
 * Windows calls the handler on its own threads, so its IUnknown part is machine code (no reference counts:
 * each handler lives as long as Harbor), and Invoke goes through a stub that hands the call to Bun's thread
 * (a threadsafe JSCallback) and answers S_OK. The interface ids and method slots are checked against the
 * Windows SDK headers (mingw-w64's windows.ui.notifications.h, windows.data.xml.dom.h, objidl.h).
 */
const IUNKNOWN_QI = [
  0x8b, 0x02, // mov eax, [rdx]            (riid's first 32 bits)
  0x85, 0xc0, // test eax, eax              IUnknown {00000000-0000-0000-C000-000000000046}
  0x74, 0x0e, // je yes
  0x3d, 0x94, 0x2b, 0xea, 0x94, // cmp eax, 0x94EA2B94   IAgileObject
  0x74, 0x07, // je yes
  0x3d, 0x2d, 0xde, 0x54, 0xab, // cmp eax, 0xAB54DE2D   TypedEventHandler<ToastNotification, IInspectable>
  0x75, 0x06, // jne no
  0x49, 0x89, 0x08, // yes: mov [r8], rcx
  0x31, 0xc0, // xor eax, eax
  0xc3, // ret
  0x49, 0xc7, 0x00, 0x00, 0x00, 0x00, 0x00, // no: mov qword [r8], 0
  0xb8, 0x02, 0x40, 0x00, 0x80, // mov eax, E_NOINTERFACE
  0xc3, // ret
];
const ONE = [0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3]; // mov eax, 1; ret

function invokeStub(target: Pointer): number[] {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(Number(target)));
  return [
    0x48, 0x83, 0xec, 0x28, // sub rsp, 40     (shadow space, 16-byte aligned)
    0x48, 0xb8, ...b, // mov rax, target
    0xff, 0xd0, // call rax        (rcx, rdx, r8 unchanged: this, sender, args)
    0x31, 0xc0, // xor eax, eax    (S_OK)
    0x48, 0x83, 0xc4, 0x28, // add rsp, 40
    0xc3, // ret
  ];
}

const clicks = new Map<number, () => void>();
let vtable: Pointer | null = null;
let invoked: JSCallback | null = null;
let nextHandler = 1;

function handler(onClick: () => void): Pointer {
  if (vtable === null) {
    invoked = new JSCallback(
      (self: Pointer) => {
        const n = read.u32(self, 8);
        clicks.get(n)?.();
      },
      { args: [P, P, P], returns: FFIType.void, threadsafe: true },
    );
    const qi = code(IUNKNOWN_QI);
    const one = code(ONE);
    const invoke = code(invokeStub(invoked.ptr as Pointer));
    vtable = pointer(kernel32().GlobalAlloc(0, 32));
    if (vtable === null) throw new Error("no memory");
    const v = new BigUint64Array([BigInt(Number(qi)), BigInt(Number(one)), BigInt(Number(one)), BigInt(Number(invoke))]);
    copyTo(vtable, new Uint8Array(v.buffer));
  }
  const n = nextHandler++;
  clicks.set(n, onClick);
  const obj = pointer(kernel32().GlobalAlloc(0, 16));
  if (obj === null) throw new Error("no memory");
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt(Number(vtable)), 0);
  b.writeUInt32LE(n, 8);
  copyTo(obj, b);
  return obj;
}

function copyTo(at: Pointer, bytes: Uint8Array): void {
  new Uint8Array(toArrayBuffer(at, 0, bytes.length)).set(bytes);
}

/** Note ids to the click handler numbers they use (a replaced note drops its old one). */
const handlerOf = new Map<string, number>();

export interface Post {
  /** A note with the same id replaces it. */
  id: string;
  title: string;
  body: string;
  sound: boolean;
  onClick?: () => void;
}

export function post(p: Post): void {
  const c = setUp();
  const old = handlerOf.get(p.id);
  if (old !== undefined) clicks.delete(old);
  handlerOf.delete(p.id);
  const doc = hstring("Windows.Data.Xml.Dom.XmlDocument", (h) => out((o) => combase().RoActivateInstance(h, o), "XmlDocument"));
  let xml: Pointer | null = null;
  let toast: Pointer | null = null;
  try {
    const io = as(doc, IID.xmlDocumentIO, "XmlDocumentIO");
    try {
      hstring(toastXml(p.title, p.body, p.sound), (h) => ok(method(io, 6, [P], h), "LoadXml"));
    } finally {
      release(io);
    }
    xml = as(doc, IID.xmlDocument, "XmlDocument");
    const x = xml;
    toast = out((o) => method(c.toastFactory, 6, [P, P], x, o), "CreateToastNotification");
    const t2 = as(toast, IID.toast2, "ToastNotification2");
    try {
      hstring(p.id, (h) => ok(method(t2, 6, [P], h), "put_Tag"));
      hstring(GROUP, (h) => ok(method(t2, 8, [P], h), "put_Group"));
    } finally {
      release(t2);
    }
    if (p.onClick) {
      const h = handler(p.onClick);
      const token = new BigInt64Array(1);
      // A refused handler leaves the note without its click; it still shows.
      if (method(toast, 11, [P, P], h, ptr(token)) >= 0) handlerOf.set(p.id, read.u32(h, 8));
    }
    ok(method(c.notifier, 6, [P], toast), "Show");
  } finally {
    release(toast);
    release(xml);
    release(doc);
  }
}

/** Takes a shown note away. */
export function remove(id: string): void {
  const n = handlerOf.get(id);
  if (n !== undefined) clicks.delete(n);
  handlerOf.delete(id);
  const h = center?.history ?? null;
  if (h === null) return;
  hstring(id, (tag) => hstring(GROUP, (group) => hstring(APP_ID, (app) => method(h, 8, [P, P, P], tag, group, app))));
}
