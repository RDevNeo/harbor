// macOS's notifications (UNUserNotificationCenter), from inside Harbor.app: macOS asks the user once,
// then shows them as Harbor's, with its icon. A click comes back to the delegate below. Loaded only on
// macOS, and only in an app bundle (outside one the framework aborts the process).
import { FFIType, type Pointer } from "bun:ffi";
import { block, call, call3, loadFramework, callBlock, callU64Block, callVoid1, callVoid2, cls, delegateClass, jsString, nsArray, nsString, pool, retain, type Id } from "./darwin-objc.ts";

loadFramework("/System/Library/Frameworks/UserNotifications.framework/UserNotifications");

const ALERT_SOUND_BADGE = (1 << 0) | (1 << 1) | (1 << 2);
/** Shown even while Harbor is in front: a banner, in the list, with its sound. */
const BANNER_LIST_SOUND = (1 << 4) | (1 << 3) | (1 << 1);

const clicks = new Map<string, () => void>();
let center: Id = null;

function setUp(): Id {
  if (center !== null) return center;
  return pool(() => {
    const c = retain(call(cls("UNUserNotificationCenter"), "currentNotificationCenter"));
    const d = delegateClass("HarborNotifyDelegate", [
      {
        sel: "userNotificationCenter:willPresentNotification:withCompletionHandler:",
        types: "v@:@@@?",
        args: 3,
        f: (_center, _note, done) => callBlock(done as Pointer, BANNER_LIST_SOUND),
      },
      {
        sel: "userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:",
        types: "v@:@@@?",
        args: 3,
        f: (_center, response, done) => {
          const id = pool(() => jsString(call(call(call(response, "notification"), "request"), "identifier")));
          clicks.get(id)?.();
          callBlock(done as Pointer);
        },
      },
    ]);
    callVoid1(c, "setDelegate:", retain(call(call(d, "alloc"), "init")));
    // macOS asks once; until the user answers (or if they said no) notes just don't show.
    callU64Block(c, "requestAuthorizationWithOptions:completionHandler:", ALERT_SOUND_BADGE, block([FFIType.bool, FFIType.ptr], FFIType.void, () => {}));
    center = c;
    return c;
  });
}

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
  if (p.onClick) clicks.set(p.id, p.onClick);
  else clicks.delete(p.id);
  pool(() => {
    const content = call(call(cls("UNMutableNotificationContent"), "alloc"), "init");
    callVoid1(content, "setTitle:", nsString(p.title));
    callVoid1(content, "setBody:", nsString(p.body));
    if (p.sound) callVoid1(content, "setSound:", call(cls("UNNotificationSound"), "defaultSound"));
    const req = call3(cls("UNNotificationRequest"), "requestWithIdentifier:content:trigger:", nsString(p.id), content, null);
    callVoid2(c, "addNotificationRequest:withCompletionHandler:", req, null);
  });
}

/** Takes a shown note away. */
export function remove(id: string): void {
  clicks.delete(id);
  if (center === null) return;
  pool(() => {
    const ids = nsArray([nsString(id)]);
    callVoid1(center, "removeDeliveredNotificationsWithIdentifiers:", ids);
    callVoid1(center, "removePendingNotificationRequestsWithIdentifiers:", ids);
  });
}
