#!/usr/bin/env bash
# DRAFT (issue #88), not wired in: release.yml's "Play upload" step is off (if: false).
#
# Makes Google Play see each release of the phone app before any phone sideloads it, so Play
# Protect's "App scan recommended: Play Protect hasn't seen this app before" stops blocking the
# app's background self-update. Steps:
#   1. upload the release's app bundle (.aab, signed with the upload key) to the Play Console's
#      internal testing track (an edit: insert, bundles.upload, tracks.update, commit);
#   2. download the universal APK that Play generated from it, signed by Play App Signing with
#      OUR app signing key (enrolled with "use existing key", so phones keep updating);
#   3. check its certificate is ours: that APK, byte for byte what Google built and scanned, is
#      what the GitHub release then carries as harbor-android.apk.
#
# Usage: upload.sh BUNDLE.aab VERSION_CODE OUT.apk
# Env:   PLAY_SERVICE_ACCOUNT  JSON key of a Google Cloud service account invited in Play Console
#                              (Users and permissions: "Release to testing tracks" for this app)
#        PLAY_APP_CERT_SHA256  the app signing certificate's SHA-256, hex, no colons (lowercase)
#        PLAY_TRACK            default "internal"
# Needs: curl, jq, openssl.
set -euo pipefail

PKG=dev.harbor.app
AAB=$1 CODE=$2 OUT=$3
TRACK=${PLAY_TRACK:-internal}
API=https://androidpublisher.googleapis.com/androidpublisher/v3/applications/$PKG
UP=https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/$PKG

# OAuth access token from the service account (JWT bearer grant, RS256 via openssl).
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
email=$(jq -r .client_email <<<"$PLAY_SERVICE_ACCOUNT")
key=$(mktemp); trap 'rm -f "$key"' EXIT
jq -r .private_key <<<"$PLAY_SERVICE_ACCOUNT" > "$key"
now=$(date +%s)
head=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
claims=$(jq -cn --arg iss "$email" --argjson iat "$now" \
  '{iss:$iss,scope:"https://www.googleapis.com/auth/androidpublisher",aud:"https://oauth2.googleapis.com/token",iat:$iat,exp:($iat+3600)}' | b64url)
sig=$(printf '%s.%s' "$head" "$claims" | openssl dgst -sha256 -sign "$key" | b64url)
token=$(curl -fsS https://oauth2.googleapis.com/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer -d "assertion=$head.$claims.$sig" | jq -r .access_token)
auth=(-H "Authorization: Bearer $token")
echo "::add-mask::$token"

# 1. The edit: upload the bundle, put it on the track, commit.
edit=$(curl -fsS "${auth[@]}" -X POST "$API/edits" | jq -r .id)
got=$(curl -fsS "${auth[@]}" -X POST -H 'Content-Type: application/octet-stream' \
  --data-binary @"$AAB" "$UP/edits/$edit/bundles?uploadType=media" | jq -r .versionCode)
[ "$got" = "$CODE" ] || { echo "Play read versionCode $got, expected $CODE" >&2; exit 1; }
curl -fsS "${auth[@]}" -X PUT -H 'Content-Type: application/json' "$API/edits/$edit/tracks/$TRACK" \
  -d "$(jq -cn --arg c "$CODE" --arg t "$TRACK" '{track:$t,releases:[{versionCodes:[$c],status:"completed"}]}')" >/dev/null
curl -fsS "${auth[@]}" -X POST "$API/edits/$edit:commit" >/dev/null
echo "Play: versionCode $CODE on $TRACK"

# 2. Play's universal APK, signed with the app signing key. Generation takes a little while.
id=
for _ in $(seq 1 30); do
  id=$(curl -fsS "${auth[@]}" "$API/generatedApks/$CODE" | jq -r --arg h "$PLAY_APP_CERT_SHA256" \
    '.generatedApks[]? | select(.certificateSha256Hash == $h) | .generatedUniversalApk.downloadId // empty')
  [ -n "$id" ] && break
  sleep 20
done
[ -n "$id" ] || { echo "Play generated no universal APK for our signing key" >&2; exit 1; }
curl -fsSL "${auth[@]}" -o "$OUT" "$API/generatedApks/$CODE/downloads/$id:download?alt=media"

# 3. Same package, same version, our certificate: or the release keeps its own APK.
bt="$ANDROID_HOME/build-tools/34.0.0"
"$bt/aapt2" dump badging "$OUT" | grep -q "package: name='$PKG' versionCode='$CODE'" \
  || { echo "Play's APK isn't $PKG $CODE" >&2; exit 1; }
cert=$("$bt/apksigner" verify --print-certs "$OUT" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)
[ "$cert" = "$PLAY_APP_CERT_SHA256" ] || { echo "Play's APK is signed by $cert, not our key" >&2; exit 1; }
echo "Play: universal APK $(du -h "$OUT" | cut -f1), signed by our key"
