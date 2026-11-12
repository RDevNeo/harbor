// A small Objective-C bridge for macOS (bun:ffi): classes, selectors and objc_msgSend called with the
// argument types each message needs. Loaded only on macOS (and only by the modules that need AppKit).
import { CFunction, CString, dlopen, FFIType, JSCallback, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";

const objc = dlopen("/usr/lib/libobjc.A.dylib", {
  objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
  sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
  objc_autoreleasePoolPush: { args: [], returns: FFIType.ptr },
  objc_autoreleasePoolPop: { args: [FFIType.ptr], returns: FFIType.void },
  objc_msgSend: { args: [], returns: FFIType.void },
  objc_allocateClassPair: { args: [FFIType.ptr, FFIType.cstring, FFIType.u64], returns: FFIType.ptr },
  objc_registerClassPair: { args: [FFIType.ptr], returns: FFIType.void },
  class_addMethod: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.bool },
});
// AppKit (NSPasteboard, NSStatusBar…) and Foundation: Slint's addon links them already; loaded here too for
// code that runs before it (and in tests).
dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", { NSBeep: { args: [], returns: FFIType.void } });

// Its address, typed per message below (Bun gives each symbol its pointer as `ptr`).
const SEND = (objc.symbols.objc_msgSend as unknown as { ptr: Pointer }).ptr;

export type Id = Pointer | null;
const P = FFIType.ptr;

/** objc_msgSend typed for one shape of message: (receiver, selector, ...args) → result. */
function send<A extends FFIType[], R extends FFIType>(args: A, returns: R) {
  return CFunction({ ptr: SEND, args: [P, P, ...args], returns });
}

const sendId = send([], P);
const sendIdId = send([P], P);
const sendIdIdId = send([P, P], P);
const sendBoolIdId = send([P, P], FFIType.bool);
const sendIdPtrLen = send([P, FFIType.u64], P);
const sendU64 = send([], FFIType.u64);
const sendI64 = send([], FFIType.i64);
const sendIdU64 = send([FFIType.u64], P);
const sendVoidId = send([P], FFIType.void);
const sendVoid = send([], FFIType.void);
const sendIdF64 = send([FFIType.f64], P);
const sendVoidBool = send([FFIType.bool], FFIType.void);
const sendVoidI64 = send([FFIType.i64], FFIType.void);
const sendVoidSize = send([FFIType.f64, FFIType.f64], FFIType.void);
const sendIdIdPtrId = send([P, P, P], P);

const sels = new Map<string, Pointer>();
const classes = new Map<string, Pointer>();

export function sel(name: string): Pointer {
  let s = sels.get(name);
  if (s === undefined) {
    s = objc.symbols.sel_registerName(Buffer.from(`${name}\0`)) as Pointer;
    sels.set(name, s);
  }
  return s;
}

export function cls(name: string): Pointer {
  let c = classes.get(name);
  if (c === undefined) {
    const p = objc.symbols.objc_getClass(Buffer.from(`${name}\0`)) as Pointer | null;
    if (p === null) throw new Error(`no Objective-C class ${name}`);
    c = p;
    classes.set(name, c);
  }
  return c;
}

/** [recv sel] → object */
export const call = (recv: Id, name: string): Id => sendId(recv, sel(name)) as Id;
/** [recv sel:a] → object */
export const call1 = (recv: Id, name: string, a: Id): Id => sendIdId(recv, sel(name), a) as Id;
/** [recv sel:a b:b] → object */
export const call2 = (recv: Id, name: string, a: Id, b: Id): Id => sendIdIdId(recv, sel(name), a, b) as Id;
/** [recv sel:a b:b] → BOOL */
export const callBool2 = (recv: Id, name: string, a: Id, b: Id): boolean => Boolean(sendBoolIdId(recv, sel(name), a, b));
/** [recv sel] → NSUInteger */
export const callU64 = (recv: Id, name: string): number => Number(sendU64(recv, sel(name)));
/** [recv sel] → NSInteger */
export const callI64 = (recv: Id, name: string): number => Number(sendI64(recv, sel(name)));
/** [recv sel:n] → object */
export const callIndex = (recv: Id, name: string, n: number): Id => sendIdU64(recv, sel(name), n) as Id;
/** [recv sel:a] → void */
export const callVoid1 = (recv: Id, name: string, a: Id): void => void sendVoidId(recv, sel(name), a);
/** [recv sel] → void */
export const callVoid = (recv: Id, name: string): void => void sendVoid(recv, sel(name));

/** Runs `f` inside an autorelease pool, so the temporary objects it makes go when it returns. */
export function pool<T>(f: () => T): T {
  const p = objc.symbols.objc_autoreleasePoolPush();
  try {
    return f();
  } finally {
    objc.symbols.objc_autoreleasePoolPop(p);
  }
}

/** An NSString (autoreleased). */
export function nsString(s: string): Id {
  return call1(cls("NSString"), "stringWithUTF8String:", ptr(Buffer.from(`${s}\0`, "utf8")));
}

/** An NSString's text. */
export function jsString(s: Id): string {
  if (s === null) return "";
  const p = call(s, "UTF8String");
  return p === null ? "" : new CString(p).toString();
}

/** An NSData with a copy of `bytes` (autoreleased). */
export function nsData(bytes: Uint8Array): Id {
  const copy = bytes.length === 0 ? new Uint8Array(1) : bytes;
  return sendIdPtrLen(cls("NSData"), sel("dataWithBytes:length:"), ptr(copy), bytes.length) as Id;
}

/** An NSData's bytes, copied. */
export function jsBytes(d: Id): Uint8Array {
  if (d === null) return new Uint8Array();
  const n = callU64(d, "length");
  const p = call(d, "bytes");
  if (n === 0 || p === null) return new Uint8Array();
  return new Uint8Array(toArrayBuffer(p, 0, n)).slice();
}

/** An NSArray's items. */
export function items(a: Id): Id[] {
  if (a === null) return [];
  const n = callU64(a, "count");
  const out: Id[] = [];
  for (let i = 0; i < n; i++) out.push(callIndex(a, "objectAtIndex:", i));
  return out;
}

/** An NSArray of `objs` (autoreleased). */
export function nsArray(objs: Id[]): Id {
  const buf = new BigUint64Array(objs.map((o) => BigInt(o ?? 0)));
  return sendIdPtrLen(cls("NSArray"), sel("arrayWithObjects:count:"), ptr(buf), objs.length) as Id;
}

/** [recv sel:(double)x] → object */
export const callF64 = (recv: Id, name: string, x: number): Id => sendIdF64(recv, sel(name), x) as Id;
/** [recv sel:(BOOL)b] → void */
export const callBool = (recv: Id, name: string, b: boolean): void => void sendVoidBool(recv, sel(name), b);
/** [recv sel:(NSInteger)n] → void */
export const callSetI64 = (recv: Id, name: string, n: number): void => void sendVoidI64(recv, sel(name), n);
/** [recv sel:(NSSize){w, h}] → void */
export const callSize = (recv: Id, name: string, w: number, h: number): void => void sendVoidSize(recv, sel(name), w, h);
/** [recv sel:a b:(SEL)s c:c] → object (initWithTitle:action:keyEquivalent:) */
export const call3Sel = (recv: Id, name: string, a: Id, s: Pointer | null, c: Id): Id => sendIdIdPtrId(recv, sel(name), a, s, c) as Id;

/** Keeps an object past its autorelease pool. */
export const retain = (o: Id): Id => call(o, "retain");
export const release = (o: Id): void => callVoid(o, "release");

const callbacks: JSCallback[] = [];

/**
 * A new NSObject subclass whose `method` (one object argument, as menu actions take) calls `f` with that
 * object. Registered once per name; the callback lives as long as the process.
 */
export function actionClass(name: string, method: string, f: (sender: Id) => void): Pointer {
  const existing = objc.symbols.objc_getClass(Buffer.from(`${name}\0`)) as Pointer | null;
  if (existing !== null) return existing;
  const c = objc.symbols.objc_allocateClassPair(cls("NSObject"), Buffer.from(`${name}\0`), 0) as Pointer | null;
  if (c === null) throw new Error(`couldn't make class ${name}`);
  const cb = new JSCallback((_self: Id, _cmd: Id, sender: Id) => f(sender), { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void });
  callbacks.push(cb);
  if (!objc.symbols.class_addMethod(c, sel(method), cb.ptr, Buffer.from("v@:@\0"))) throw new Error(`couldn't add ${method} to ${name}`);
  objc.symbols.objc_registerClassPair(c);
  return c;
}

// Blocks (the ^(…){…} closures Apple's APIs take): a global block in memory whose invoke is a JSCallback.
const sys = dlopen("/usr/lib/libSystem.B.dylib", {
  dlopen: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.ptr },
  dlsym: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
}).symbols;
const BLOCK_IS_GLOBAL = 1 << 28;
let globalBlockIsa: Pointer | null = null;
const blocks: { mem: Uint8Array; desc: Uint8Array; cb: JSCallback }[] = [];

/**
 * A block that calls `f` with its arguments (after the block itself), typed `args` → `returns`. Apple may
 * call it on any thread: the callback is threadsafe (it runs on Bun's thread). It lives as long as the process.
 */
export function block(args: FFIType[], returns: FFIType, f: (...a: never[]) => unknown): Pointer {
  if (globalBlockIsa === null) {
    const h = sys.dlopen(Buffer.from("/usr/lib/libSystem.B.dylib\0"), 1) as Pointer | null;
    globalBlockIsa = sys.dlsym(h, Buffer.from("_NSConcreteGlobalBlock\0")) as Pointer | null;
    if (globalBlockIsa === null) throw new Error("no _NSConcreteGlobalBlock");
  }
  const cb = new JSCallback((_blk: Pointer, ...a: never[]) => f(...a), { args: [FFIType.ptr, ...args], returns, threadsafe: true });
  const desc = new Uint8Array(16);
  new DataView(desc.buffer).setBigUint64(8, 32n, true);
  const mem = new Uint8Array(32);
  const v = new DataView(mem.buffer);
  v.setBigUint64(0, BigInt(globalBlockIsa), true);
  v.setInt32(8, BLOCK_IS_GLOBAL, true);
  v.setBigUint64(16, BigInt(cb.ptr as number), true);
  v.setBigUint64(24, BigInt(ptr(desc)), true);
  blocks.push({ mem, desc, cb });
  return ptr(mem);
}

/** Loads a system framework by path (its classes register with the Objective-C runtime). */
export function loadFramework(path: string): void {
  if (sys.dlopen(Buffer.from(`${path}\0`), 1) === null) throw new Error(`couldn't load ${path}`);
}

/** Calls a block Apple handed over (a completion handler), with one integer argument or none. */
export function callBlock(b: Pointer | null, n?: number): void {
  if (b === null) return;
  const invoke = read.ptr(b, 16) as Pointer;
  if (n === undefined) CFunction({ ptr: invoke, args: [P], returns: FFIType.void })(b);
  else CFunction({ ptr: invoke, args: [P, FFIType.u64], returns: FFIType.void })(b, n);
}

/** [recv sel:a b:(NSUInteger)n …] shapes the notification center needs. */
const sendVoidU64Ptr = send([FFIType.u64, P], FFIType.void);
const sendVoidPtrPtr = send([P, P], FFIType.void);
const sendIdIdIdId = send([P, P, P], P);
export const callU64Block = (recv: Id, name: string, n: number, b: Pointer | null): void => void sendVoidU64Ptr(recv, sel(name), n, b);
export const callVoid2 = (recv: Id, name: string, a: Id, b: Pointer | null): void => void sendVoidPtrPtr(recv, sel(name), a, b);
export const call3 = (recv: Id, name: string, a: Id, b: Id, c: Id): Id => sendIdIdIdId(recv, sel(name), a, b, c) as Id;

/**
 * A new NSObject subclass with methods whose JavaScript gets every object argument after self and _cmd.
 * `types` is each method's Objective-C type string ("v@:@@@?" and such).
 */
export function delegateClass(name: string, methods: { sel: string; types: string; args: number; f: (...a: (Pointer | null)[]) => void }[]): Pointer {
  const existing = objc.symbols.objc_getClass(Buffer.from(`${name}\0`)) as Pointer | null;
  if (existing !== null) return existing;
  const c = objc.symbols.objc_allocateClassPair(cls("NSObject"), Buffer.from(`${name}\0`), 0) as Pointer | null;
  if (c === null) throw new Error(`couldn't make class ${name}`);
  for (const m of methods) {
    const cb = new JSCallback((_self: Pointer, _cmd: Pointer, ...a: (Pointer | null)[]) => m.f(...a), {
      args: [FFIType.ptr, FFIType.ptr, ...Array<FFIType>(m.args).fill(FFIType.ptr)],
      returns: FFIType.void,
      threadsafe: true,
    });
    callbacks.push(cb);
    if (!objc.symbols.class_addMethod(c, sel(m.sel), cb.ptr, Buffer.from(`${m.types}\0`))) throw new Error(`couldn't add ${m.sel} to ${name}`);
  }
  objc.symbols.objc_registerClassPair(c);
  return c;
}
