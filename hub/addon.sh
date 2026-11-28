#!/bin/bash
# The hub as a Home Assistant add-on (ha-addon/, docs/hub.md "In Home Assistant"): hub/start.sh comes here when the
# Supervisor started the image (SUPERVISOR_TOKEN and /data/options.json are there), as root.
#   /data/hub      the hub's data folder (the bridge's user's)          /data/keeper  the keeper's folder (root's, 0700)
#   /share/opie    backups to a folder, when the add-on has /share (else /data/hub/backups)
#   /ssl           the certificate for https on the home network, when the ssl option is on
# The keeper runs as root and is the only one given the Supervisor's token; the bridge and the apps' server run as the
# image's node user (OPENHOUSE_RUN_AS), so they can't read the token, the keeper's folder or its environment.
# Home Assistant starts the add-on again only if its watchdog is on, so a hub that stops (a restore, a crash) is started
# again here.
set -uo pipefail
C=${OPENHOUSE_CODE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
opt() { node -e 'const o = JSON.parse(require("fs").readFileSync("/data/options.json", "utf8")); const v = o[process.argv[1]]; process.stdout.write(v === undefined || v === null ? "" : String(v))' "$1" 2>/dev/null; }

export OPENHOUSE_ADDON=1 OPENHOUSE_INSTALL=addon OPENHOUSE_DATA=/data/hub OPENHOUSE_KEEPER_DIR=/data/keeper OPENHOUSE_RUN_AS=${OPENHOUSE_RUN_AS:-node}
mkdir -p /data/hub /data/keeper && chmod 700 /data/keeper
if [ -d /share ] && touch /share/.opie-check 2>/dev/null; then rm -f /share/.opie-check; mkdir -p /share/opie; export OPENHOUSE_BACKUP_DIR=/share/opie; chown "$OPENHOUSE_RUN_AS:" /share/opie
else export OPENHOUSE_BACKUP_DIR=/data/hub/backups; fi

# https on the home network (the microphone in phone browsers): Home Assistant's own certificate, copied where the
# bridge's user may read it.
if [ "$(opt ssl)" = true ]; then
  CERT="/ssl/$(opt certfile)" KEY="/ssl/$(opt keyfile)"
  if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    mkdir -p /data/hub/.hub-tls && install -m 600 -o "$OPENHOUSE_RUN_AS" "$CERT" /data/hub/.hub-tls/cert.pem && install -m 600 -o "$OPENHOUSE_RUN_AS" "$KEY" /data/hub/.hub-tls/key.pem
    export HUB_TLS_CERT=/data/hub/.hub-tls/cert.pem HUB_TLS_KEY=/data/hub/.hub-tls/key.pem
  else echo "$(date '+%F %T') ssl is on, but $CERT or $KEY isn't there: serving http"; fi
else rm -rf /data/hub/.hub-tls; fi

# A lost PIN: the forget_pin option is the add-on's console (whoever may change it in Home Assistant owns the hub).
[ "$(opt forget_pin)" = true ] && touch /data/keeper/forget-pin

child=
trap '[ -n "$child" ] && kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
first=1
while true; do
  bash "$C/hub/start.sh" &
  child=$!
  # A new settings code once it's up (the settings_code option), and the PIN forgotten (forget_pin).
  if [ -n "$first" ] && { [ "$(opt settings_code)" = true ] || [ "$(opt forget_pin)" = true ]; }; then
    ( for _ in $(seq 1 90); do sleep 2; curl -s -o /dev/null http://127.0.0.1:${PORT:-8787}/ && break; done
      cd /data/hub && OPENHOUSE_DATA=/data/hub OPENHOUSE_KEEPER_DIR=/data/keeper bash "$C/hub/owner-code.sh" $([ "$(opt forget_pin)" = true ] && echo --forget-pin) ) &
  fi
  first=
  wait "$child"
  echo "$(date '+%F %T') the hub stopped: starting it again"
  sleep 3
done
