# Harbor for Android

A chat-only phone client of a desktop Harbor (the "hub"). The phone runs no agent: it lists,
opens, starts and drives the hub's chats over the tailnet (device, account, model, effort,
access, fast), and can rename, settle, fork and delete them. The API is in
[PROTOCOL.md](PROTOCOL.md).

## Install and pair

1. On the PC: Harbor › Settings › Phones. Scan the install QR code with the phone (or download
   `harbor-android.apk` from the GitHub release) and allow the browser to install it.
2. Pair: scan the pairing QR code with the phone's camera app (it opens the `harbor://pair`
   link in Harbor), or tap **+** in the app to scan it with a QR app, paste the link, or type
   host, port and token. Several PCs can be paired.
3. Updates: when the PC has a newer app, the chat list shows **Update**; Settings › Update
   installs it (Android asks once to allow "Install unknown apps" for Harbor; Android 12+
   updates silently after that).

The phone and the PC must be on the same tailnet (Tailscale), with Harbor open on the PC.

## Build

`android/build.sh` builds `android/build/harbor-android.apk` with the SDK's own tools (aapt2,
javac, d8, zipalign, apksigner): no Gradle, no third-party code. It needs JDK 17 and an SDK
with `platforms;android-34` and `build-tools;34.0.0`, and the signing keystore (see the
script's header). versionCode comes from Cargo.toml (`0.7.0` → `7000`). The release workflow
builds and signs it with the keystore kept in the repository's secrets; every build must use
that same key, or phones need to uninstall before updating.
