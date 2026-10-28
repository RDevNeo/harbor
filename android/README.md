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
3. Updates: when the PC has a newer app, the chat list shows **Update**; Settings › Update
   installs it (Android asks once to allow "Install unknown apps" for Harbor; Android 12+
   updates silently after that).

The phone reaches the PC on any network the two share (the same Wi-Fi, or a VPN of yours), with
Harbor open on the PC. Every connection is mutual TLS pinned to the PC's key and the phone's own
Keystore key ([PROTOCOL.md](PROTOCOL.md#transport)); no other software is needed.

## Build

`android/build.sh` builds `android/build/harbor-android.apk` with the SDK's own tools (aapt2,
javac, d8, zipalign, apksigner): no Gradle, no third-party code. It needs JDK 17 and an SDK
with `platforms;android-34` and `build-tools;34.0.0`, and the signing keystore (see the
script's header). versionCode comes from Cargo.toml (`0.7.0` → `7000`). The release workflow
builds and signs it with the keystore kept in the repository's secrets; every build must use
that same key, or phones need to uninstall before updating.
