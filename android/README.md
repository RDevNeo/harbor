# Hub for Android

Hub is Harbor's Android app rebranded on this branch: app name **Hub**, applicationId
`dev.hub.app`, `hub://` links, its own icon. It installs beside Harbor and Person Hub and pairs
only with Hub on the PC (QR code, `hub://pair?…`; [PROTOCOL.md](PROTOCOL.md#hub-pairing)), never
with Harbor's account service or PCs. Build: `android/build.sh` → `android/build/hub-android.apk`.
Updates come from the paired Hub PC, not GitHub: it builds the app's code on every push to `hub` that changes
it, signs it with Hub's code key (shell 6+) and serves it under `/phone/`; the app takes it without an install
(HUB.md "Updates"). Only a shell change needs the APK, which the app downloads from the PC and offers itself.
Harbor's notes below still describe the rest of the app (read "the PC" where they say GitHub's releases).

# Harbor for Android

A chat-only phone client of a desktop Harbor (the "hub"). The phone runs no agent: it lists,
opens, starts and drives the hub's chats over your network (device, account, model, effort,
access, fast), and can rename, settle, fork and delete them. A chat's team (agents, processes,
wake-ups, webhooks) slides in from the right. Typing `/` in a chat's message box opens the
desktop's slash menu (commands and skills from the PC). The API is in [PROTOCOL.md](PROTOCOL.md).

## Install and sign in

1. On the PC: Harbor › Settings › Phones shows an install QR code: scan it with the phone and let
   the browser install the APK. Otherwise use **Download the app** there, or get
   `harbor-android.apk` from the GitHub release.
2. Sign in with Google in the app, with the account you use in Harbor on your PC (or the one a
   workspace invited). The PCs of your workspaces show up by themselves and connect directly, each
   pinned to its own key; there's no pairing code. Owners invite people in Settings (the
   workspace's card) or on the PC (Settings › Account).
3. Updates come from Harbor's GitHub releases by themselves. On Android 9+ they are the app's code
   alone (below): nothing installs, so Google Play Protect has nothing to scan, and they go in
   while you use Harbor: within seconds of a release, at a quiet moment, the app restarts in place
   and you're back on the same screen ("Updated to X"; see "Live updates"). Settings › App ›
   **Update** does it at once. Only a release
   that changes the shell installs an APK (Android asks once to allow "Install unknown apps" for
   Harbor; Android 12+ updates silently after that), as every update does on Android 8.

The phone reaches the PC on any network the two share (the same Wi-Fi, or a VPN of yours), with
Harbor open on the PC. Every connection is mutual TLS pinned to the PC's key and the phone's own
Keystore key ([PROTOCOL.md](PROTOCOL.md#transport)); no other software is needed.

## Links

Web links in chats open in the phone's own browser (Harbor had a built-in Servo browser until
0.176; it was removed).

Other apps and browsers open a chat with its link, the one agents write in replies:
`harbor://chat/<chat id>?pc=<PC name>` (`?pc=` optional; Harbor › a chat's Copy link gives it).
Harbor opens that chat over its workspace's chat list, from a cold start too; before sign-in it
waits (15 minutes at most) and opens the chat once you're signed in. A chat none of your PCs has
opens Harbor as usual with a short notice. From an Android app it's an `ACTION_VIEW` intent with
that URI; from a web page or a Capacitor/WebView app, a link or `window.location.href` to it.

A link may hand the chat some text too: `&context=<text>` (at most 4 KB, `encodeURIComponent`'d),
optionally `&from=<your app's name>`. It never starts anything: the chat shows a folded "Context
from …" card, named after the app Android says opened the link (else your `from`, marked
unverified), and the agent gets the text with your next message, quoted and marked as written by
that app, not by you ([PROTOCOL.md](PROTOCOL.md), `POST /v1/chats/{id}/context`).

## Other apps chat through Harbor

An app on the phone (a Capacitor/WebView app too) can hold a chat with one Harbor chat without
opening Harbor: Harbor serves a small JSON API on `127.0.0.1:47999` (this phone only) while it runs,
and passes the messages over its own connection to the PCs. The app asks once: it opens an approval
link, Harbor shows "Let *App* chat with “*chat*”?" (or, when Android doesn't say which app opened
the link, names it by what it calls itself and says it couldn't confirm it), steps back to the app,
and an allowed app gets a token for that chat.
Settings › Other apps lists them and takes one back with a tap. Since 0.194 an app can send
photos and PDFs with a message (delivered as the composer's attachments) and read a chat's files
back, and send a voice message, which Harbor transcribes as the composer's mic does. The API, CORS and limits are in
[PROTOCOL.md](PROTOCOL.md#local-api-for-other-apps-phone-0193).

## Build

`android/build.sh` builds `android/build/harbor-android.apk` and `harbor-phone-code.zip` beside it
(the app's code alone, below) with the SDK's own tools (aapt2, javac, d8, zipalign, apksigner): no
Gradle. Builds run on boat.dev (`scripts/boat/android`), not on a PC. It needs JDK 17 and an SDK
with `platforms;android-34` and `build-tools;34.0.0`, and the signing keystore (see the
script's header). versionCode comes from ts/package.json (`0.7.0` → `7000`). The release workflow
builds and signs it with the keystore kept in the repository's secrets; every build must use
that same key, or phones need to uninstall before updating.

## Shell and code

The installed APK is a **shell** that rarely changes; the app's real code comes with every release
as `harbor-phone-code.zip` and is downloaded, checked and loaded at runtime. Updates swap only the
code, so the APK on the phone stays the same and Android never installs anything for them.

**What's in the shell** (`android/shell/`, plus what only an install can change):

- `AndroidManifest.xml`: permissions, every activity, service, receiver and provider (by class name),
  and `android:appComponentFactory="dev.harbor.shell.Factory"`.
- `res/` (icons, theme, strings, network config), the native libraries (sherpa-onnx) and the VAD
  model, pinned in `build.sh`.
- `dev.harbor.shell.*`: `Factory` (Android 9+ asks it for the class loader all components are made
  from), `Shell` (the API the code calls), `Boot` (which code runs; staging, trial and rollback),
  `Minisign` (Harbor's release key and the signature check), `Restart` (reopens Harbor after an
  update tapped on a screen, from a process of its own).
- The code of the release it was built from ("bundled"), so a fresh install works offline.

**What's in the code** (`harbor-phone-code.zip`): the dex of `android/src`, `third_party`'s Java and
the Play services client libraries (every class but `dev.harbor.shell.*`), the fonts and logos
(`assets/`), and `harbor-code.properties` (`code`, `version`, `minShell`).

**The contract.** A code update may change anything in the code: screens, behaviour, the protocol,
new classes, new icons in the Lucide font, new logos. It needs a new shell when it adds or renames a
manifest component, a permission, a resource, a native library, or needs new `Shell` API. The code
is compiled without `R` (resources are found by name, `Ui.res`, `Ui.statIcon`), against the shell's
classes, and must keep the manifest's class names. The shell only grows: a newer shell keeps every
older component, resource and `Shell` method, so older code keeps running on it.

**Waiting for the next shell bump.** Changes that need a new shell but don't justify one alone (a bump sets
`minShell` to the new version, so phones on the old shell get no more code until they install the APK). Whoever
bumps the shell next adds these to `AndroidManifest.xml` in the same change, then removes them from this list:

Nothing is waiting (shell 7, 2026-11-27, took `SET_ALARM`: Routine › Sleep sets the wake-up alarm in the Clock
app itself).

**Versions.** `android/shell/shell.lock` holds the shell's version and a hash of its inputs
(manifest, `res/`, `shell/src`, `build.sh`'s native pins). `build.sh` refuses to build when the
hash changed and the version didn't: run `android/shell/lock.sh bump` and commit the lock (plain
bash, no SDK). Every build makes the APK and the code zip from the same tree; the code's `minShell`
is the shell version it was built with. `harbor-app.json` names both:
`apk {code, release, shell}` and `phone {code, release, minShell}` (the release job's plan reads the
lock; a release that doesn't touch `android/` or the fonts and logos names the previous ones again).
The phone (`Update`, `Quiet.route`) takes the code whenever it's newer and `minShell` ≤ its shell; it
installs the APK only when the newest code needs a newer shell, on Android 8 (no
AppComponentFactory: always the APK's code), or for a release that names no code.

**Loading.** The code zip is downloaded beside the APK's path (`Update.stage`), then
`Shell.stage` checks its minisign signature with Harbor's release key for that release and
file name, reads `harbor-code.properties` (newer than what runs, `minShell` ≤ this shell), and keeps
it read-only (Android 14 loads no writable dex) in the app's `harbor-code/` folder with
`state.properties`. It runs from the next process start: `Factory` asks `Shell.boot`, which builds a
`DexClassLoader` over the zip (its classes first, the shell's from the APK, the native libraries from
the APK's folder), so every activity, service and receiver of the manifest is made from the new code.
`Update.round` ends the process for it once nobody sees Harbor (`Quiet.now`), and only when the
instant-notification service could start again from the background (Android before 12, or Harbor
exempt from battery optimisation) or the code waited 12 hours (`Quiet.restart`); Settings' Update
restarts at once and reopens Harbor on the chat you had.

**Live updates** (`Swap`, `Live`; code only, shell 1 as it is). A process can't unload the
classes it runs, so new code on screen is a fast restart that brings the user back. While a Harbor
screen is up, the release news is held (Listen's thread, or `Update.hold` when Listen doesn't run),
so a release is heard within seconds; its code is downloaded and staged in the background
(`Update.codeRound`), and `Swap` waits for a moment that loses nothing (`Live.why`): the window
has the focus (no sheet, menu, dialog, permission prompt or notification shade over it), nothing
records, plays a video, writes to a PC (`Hub.writes`: sends, uploads) or waits for another app's
answer, no finger is down, no text field other than the composer has text, and the screen is one
that can come back (`Live.keep`: not a form like New chat). Then: a screen that just came up,
2 s untouched, or, with a message in the composer, 12 s; after 5 minutes waiting, 0.6 s is
enough. It writes the task's screens down (`Live.Saved` in the preferences: each screen's class
and kept extras; the chat's composer text, cursor and keyboard, the item at the top of the
transcript and its offset, an open side panel), starts the shell's `Restart` without animation
and leaves its own screen as it is; `Restart` ends the process and opens Harbor, whose first
screen (`Hubs`, drawn blank) opens the same screens again at once (`Swap.restore`), with a short
"Updated to X" toast. Listen starts again from that screen. The state is kept until a screen has
stayed up 8 s (at most 10 minutes, 4 restores), so new code that crashes, and is rolled back by
the shell, still comes back to the same place on the old code. Settings' Update takes the same
path. Out of sight, the restart is the quiet one below.

**Back where you were, always.** Every tab comes back, not only Projects: Persons (the page: a
person's chat with its composer text and cursor, AI or person, the reply or forward, the first
email's subject, the channel picked, the message at the top and its offset, Details; All people
with its search; a site request with its reply), Routine (the page, the Coach's draft, the
scroll) and Collector (the view, its filter, the lead at the top of the list, an open lead with
its queue and the note being typed; Send message is a form and holds the restart). The task's
screens come back in the order they were last in front (`Base.frontSeq`: tabs reorder their
screens). The same `Live.Saved` is also written all along (`Swap.AUTO`, `live_auto` in the
preferences): 0.8 s after a tap, a key or text typed, whenever a screen leaves the front, once a
minute while one is up, and before an APK install or a restart by the shell. So the first screen
of a process that a crash, Android or an APK install ended opens the same screens too (not when
the user backed out of the app: that forgets it; not older than 10 minutes; its restores count
towards the 4, so a screen that crashes on the way back stops coming back). Persons drafts also
stay per person, section and recipient (`persons` preferences, `draft\n<PC>\n<person>\n<section>\n<ai|person>`),
and the Coach's in `routine_coach_draft`. A test build tries it with
`scripts/boat/phoneshot --broadcast dev.harbor.app.RIG_LIVE_RESTART` (a live restart into the same
code) or `RIG_CRASH` (the process ends as in a crash, no live state written).

**Rollback.** New code starts on trial: the shell counts its starts and uncaught exceptions. It
proves itself when a screen stays up 5 seconds (`Base.onResume` → `Shell.ok`) or a process runs
10 minutes without a crash. 2 crashes or 6 starts before that and it's marked bad, never run again,
and the process starts on the last good code (or the APK's). Code ART can't load is bad at once.
A newer APK installed always wins over older downloaded code, which is deleted.

**What users do once.** Install the first shell APK (the release that brings shells installs it
the usual way, an APK update with Play Protect's scan if it asks). From then on, Android 9+ phones
update without installs until a release bumps the shell.

**Testing.** `test/BootTest.java` (staging and signatures with a throwaway key, the start/trial/
rollback state machine), `test/UpdateTest.java` (`Quiet.route`, `Quiet.restart`) and
`test/LiveTest.java` (when a live restart may happen, and the saved state's round trip) run with
every build. `scripts/boat/phoneshot --code` runs the app on the emulator from a staged code zip one
patch version newer than the APK (Settings then shows that version) and prints the shell's log.
