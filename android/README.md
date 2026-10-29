# Harbor for Android

A chat-only phone client of a desktop Harbor (the "hub"). The phone runs no agent: it lists,
opens, starts and drives the hub's chats over your network (device, account, model, effort,
access, fast), and can rename, settle, fork and delete them. A chat's team (agents, processes,
wake-ups, webhooks) slides in from the right. Typing `/` in a chat's message box opens the
desktop's slash menu (commands and skills from the PC). The API is in [PROTOCOL.md](PROTOCOL.md).

## Install and pair

1. On the PC: Harbor › Settings › Phones, turn on **Phone access**. While it's on and the PC has
   the app, the page shows an install QR code: scan it with the phone and let the browser
   install the APK. Otherwise use **Download the app** there, or get `harbor-android.apk` from
   the GitHub release.
2. Pair: click **Pair a phone** on the PC (each phone gets its own key) and scan the pairing QR
   code with the phone's camera app (it opens the `harbor://pair` link in Harbor), or tap **+**
   in the app to scan it with a QR app, paste the link, or type host, port and token. The phone
   then shows a 6-digit code: confirm it on the PC (Settings › Phones). The phone needs a screen
   lock: it's the third factor, asked for when a session starts more than 5 minutes after the
   last unlock. Several PCs can be paired.
3. Updates: when the PC has a newer app, the chat list shows **Update**; Settings › Update
   installs it (Android asks once to allow "Install unknown apps" for Harbor; Android 12+
   updates silently after that).

The phone reaches the PC on any network the two share (the same Wi-Fi, or a VPN of yours), with
Harbor open on the PC. Every connection is mutual TLS pinned to the PC's key and the phone's own
Keystore key ([PROTOCOL.md](PROTOCOL.md#transport)); no other software is needed.

## Browser

Web links in chats open in Harbor's own browser (also in the drawer, **Browser**): Servo, the
same engine as the desktop's browser pane, drawing with its own GL into the screen. No WebView,
Chromium or GeckoView. It has a URL bar, back, forward, reload, touch scrolling, taps, the soft
keyboard and rotation; ↗ hands the page to the phone's own browser. It runs in a process of its
own (`:browser`), so its memory goes away when it closes and a crash there leaves the chats
running. The engine (`android/servo`, `libharborservo.so`) ships for arm64-v8a and armeabi-v7a (phones
with a 32-bit Android, like the Galaxy A13), about 80 MB of the APK, and needs Android 9;
elsewhere links open in the phone's browser as before, and Settings › Built-in browser says why.

## Build

`android/build.sh` builds `android/build/harbor-android.apk` with the SDK's own tools (aapt2,
javac, d8, zipalign, apksigner): no Gradle, no third-party code. It needs JDK 17 and an SDK
with `platforms;android-34` and `build-tools;34.0.0`, and the signing keystore (see the
script's header). versionCode comes from Cargo.toml (`0.7.0` → `7000`). The release workflow
builds and signs it with the keystore kept in the repository's secrets; every build must use
that same key, or phones need to uninstall before updating.

The browser engine is built separately (it compiles all of Servo): `android/servo/build.sh`
with the NDK r29, cargo-ndk and rustup's Android targets puts `out/<abi>/libharborservo.so`
(and the NDK's `libc++_shared.so`) where `build.sh` packages it; `ABIS=x86_64` for the
emulator. Without it the APK simply has no browser. CI builds it once per change of
`android/servo` (browser.yml) and adds it to the release APK before signing.
