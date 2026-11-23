#!/bin/bash
# Make the release key, once, and the lineage that lets tablets signed with this Mac's debug key take releases
# signed with it (APK Signature Scheme v3 key rotation). docs/self-update.md.
#
#   scripts/release-key.sh [dir] [--lineage]     (default ~/.openhouse/release; never inside the repo)
#
# Writes dir/release.jks (a PKCS12 keystore, alias "release"). Its password is made here (random) and kept in this
# Mac's login keychain (item "roo-home-release-key"), where scripts/release.sh finds it; OPENHOUSE_RELEASE_KS_PASS
# gives one instead. Afterwards keep the key file and the password in the password manager as well: lose the key and
# no tablet takes an update again without a reset.
#
# --lineage also writes dir/debug-to-release.lineage, which lets a tablet running a debug build of the same package
# take releases signed with this key (APK Signature Scheme v3 rotation). Not needed for OpenHouse's own package IDs
# (computer.openhouse.*): no tablet ever ran a debug build under them; the family tablet moves over from the old IDs
# instead (docs/self-update.md, "Moving to OpenHouse"). The debug key it starts from is ~/.android/debug.keystore
# (OPENHOUSE_DEBUG_KS).
set -eo pipefail
cd "$(dirname "$0")/.."
. scripts/env.sh
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
DIR= LINEAGE=
for a in "$@"; do case "$a" in --lineage) LINEAGE=1 ;; *) DIR=$a ;; esac; done
DIR=${DIR:-$HOME/.openhouse/release}
ITEM=roo-home-release-key
DEBUG=${OPENHOUSE_DEBUG_KS:-$HOME/.android/debug.keystore}
# With the key already there, only the lineage is (re)made, if it's missing.
if [ -e "$DIR/release.jks" ]; then
  [ -n "$LINEAGE" ] && [ ! -e "$DIR/debug-to-release.lineage" ] || { echo "$DIR/release.jks is already there: not replacing it." >&2; exit 1; }
  LINEAGE_ONLY=1
fi
mkdir -p "$DIR"; DIR=$(cd "$DIR" && pwd -P)
case "$DIR/" in "$(pwd -P)"/*) echo "Not inside the repo: $DIR" >&2; rmdir "$DIR" 2>/dev/null; exit 1 ;; esac
chmod 700 "$DIR"
if [ -z "$OPENHOUSE_RELEASE_KS_PASS" ] && [ -n "$LINEAGE_ONLY" ]; then
  P=$(security find-generic-password -s "$ITEM" -a release -w 2>/dev/null) || { read -rsp "Release key password: " P; echo; }
  export OPENHOUSE_KS_P=$P; OPENHOUSE_RELEASE_KS_PASS=env:OPENHOUSE_KS_P
elif [ -z "$OPENHOUSE_RELEASE_KS_PASS" ]; then
  security find-generic-password -s "$ITEM" -a release >/dev/null 2>&1 && { echo "The keychain already has a $ITEM password: not making another." >&2; exit 1; }
  P=$(openssl rand -hex 24) # no pipe: under pipefail, tr | head dies of SIGPIPE
  security add-generic-password -s "$ITEM" -a release -l "OpenHouse release key ($DIR/release.jks)" -w "$P"
  echo "The key's password is in the login keychain as \"$ITEM\"."
  export OPENHOUSE_KS_P=$P; OPENHOUSE_RELEASE_KS_PASS=env:OPENHOUSE_KS_P
fi
pass_value() { # apksigner's pass:/env:/file: forms, for keytool
  local p=$OPENHOUSE_RELEASE_KS_PASS v
  if [ "${p#pass:}" != "$p" ]; then echo "${p#pass:}"
  elif [ "${p#env:}" != "$p" ]; then v=${p#env:}; echo "${!v}"
  elif [ "${p#file:}" != "$p" ]; then cat "${p#file:}"; fi
}
PASS_VALUE=$(pass_value)
[ -n "$LINEAGE_ONLY" ] || OPENHOUSE_KS_PW_TMP=$PASS_VALUE keytool -genkeypair -keystore "$DIR/release.jks" -storetype PKCS12 -alias release -keyalg RSA -keysize 4096 \
  -validity 36500 -dname "CN=${OPENHOUSE_KEY_CN:-OpenHouse release}" -storepass:env OPENHOUSE_KS_PW_TMP
if [ -z "$LINEAGE" ]; then :
elif [ -f "$DEBUG" ]; then
  # What the debug key keeps: the release key takes over the app and its data (installed-data), and the permissions
  # the app declares (permission: without it Android refuses the move, over a permission AndroidX declares in every
  # app). Not rollback (a debug-signed APK could then update a release-signed tablet: debug keys aren't secret), not
  # auth (an app signed with a debug key would pass as ours to checkSignatures, which the agent's app trusts).
  "$BT/apksigner" rotate --out "$DIR/debug-to-release.lineage" \
    --old-signer --ks "$DEBUG" --ks-key-alias androiddebugkey --ks-pass pass:android \
      --set-installed-data true --set-shared-uid false --set-permission true --set-rollback false --set-auth false \
    --new-signer --ks "$DIR/release.jks" --ks-key-alias release --ks-pass "$OPENHOUSE_RELEASE_KS_PASS"
  echo "Lineage: $DIR/debug-to-release.lineage (debug key $(keytool -list -keystore "$DEBUG" -storepass android -alias androiddebugkey | grep -o 'SHA-256.*' | head -c 40)…)"
else
  echo "No debug key at $DEBUG: no lineage (tablets set up with debug builds can't take releases)." >&2
fi
chmod 600 "$DIR"/*
echo "Release key: $DIR/release.jks (alias release), certificate SHA-256 (shell/gradle.properties openhouse.releaseCert):"
keytool -exportcert -keystore "$DIR/release.jks" -alias release -storepass "$PASS_VALUE" 2>/dev/null | shasum -a 256 | cut -d' ' -f1
echo "Now store the key file and its password in the password manager too."
