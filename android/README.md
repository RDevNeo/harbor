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
   alone (below): nothing installs, so Google Play Protect has nothing to scan, and Harbor restarts
   into it once you're not looking (Settings › App › **Update** does it at once). Only a release
   that changes the shell installs an APK (Android asks once to allow "Install unknown apps" for
   Harbor; Android 12+ updates silently after that), as every update does on Android 8.

The phone reaches the PC on any network the two share (the same Wi-Fi, or a VPN of yours), with
Harbor open on the PC. Every connection is mutual TLS pinned to the PC's key and the phone's own
Keystore key ([PROTOCOL.md](PROTOCOL.md#transport)); no other software is needed.

## Links

Web links in chats open in the phone's own browser (Harbor had a built-in Servo browser until
0.176; it was removed).

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

**Rollback.** New code starts on trial: the shell counts its starts and uncaught exceptions. It
proves itself when a screen stays up 5 seconds (`Base.onResume` → `Shell.ok`) or a process runs
10 minutes without a crash. 2 crashes or 6 starts before that and it's marked bad, never run again,
and the process starts on the last good code (or the APK's). Code ART can't load is bad at once.
A newer APK installed always wins over older downloaded code, which is deleted.

**What users do once.** Install the first shell APK (the release that brings shells installs it
the usual way, an APK update with Play Protect's scan if it asks). From then on, Android 9+ phones
update without installs until a release bumps the shell.

**Testing.** `test/BootTest.java` (staging and signatures with a throwaway key, the start/trial/
rollback state machine) and `test/UpdateTest.java` (`Quiet.route`, `Quiet.restart`) run with every
build. `scripts/boat/phoneshot --code` runs the app on the emulator from a staged code zip one
patch version newer than the APK (Settings then shows that version) and prints the shell's log.
