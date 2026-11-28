#!/bin/bash
# Install Opie as a hub on any Debian or Ubuntu machine, arm64 or x86_64: a Raspberry Pi, a NUC, an old laptop,
# Ubuntu under WSL on Windows. docs/hub.md
#   curl -fsSL https://raw.githubusercontent.com/mrubens/opie/main/hub/install.sh | sudo bash
#   or from a checkout: sudo hub/install.sh
# Installs git and Node 22, puts Opie in /opt/openhouse (a git checkout of the newest release, so the settings page can
# update it), builds it, and runs it as the openhouse service with its data in /var/lib/openhouse. The keeper
# (hub/keeper.mjs) runs as a user of its own, openhouse-keeper, from a copy only root can change, so nothing run as the
# openhouse user (the bridge, the household's apps, an update) can read its seal key. Run again to repair or update
# (that's also what moves the keeper's own code on).
set -euo pipefail
REPO=${OPENHOUSE_REPO:-https://github.com/mrubens/opie.git}
BRANCH=${OPENHOUSE_BRANCH:-main}
CODE=/opt/openhouse DATA=/var/lib/openhouse KEEPER_CODE=/opt/openhouse-keeper NODE_VERSION=22.23.4
KEEPER_DIR=$DATA-keeper KEEPER_TOKEN=/etc/openhouse/keeper.token KEEPER_PORT=8790
# Node's own SHASUMS256.txt for $NODE_VERSION (nodejs.org/dist): move them with the version.
declare -A NODE_SHA256=([arm64]=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b [x64]=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce)
[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }

echo "== packages"
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends git ca-certificates curl xz-utils zip procps

echo "== Node $NODE_VERSION"
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) echo "Not a machine this runs on: $(uname -m)"; exit 1 ;; esac
if ! /opt/node/bin/node -v 2>/dev/null | grep -q "^v$NODE_VERSION$"; then
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  curl -fsSL -o "$T/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz"
  echo "${NODE_SHA256[$ARCH]}  $T/node.tar.xz" | sha256sum -c --quiet - || { echo "Node's download isn't the one expected: stopping."; exit 1; }
  rm -rf /opt/node "/opt/node-v$NODE_VERSION-linux-$ARCH"
  tar -xJ -C /opt --no-same-owner -f "$T/node.tar.xz"
  ln -sfn "/opt/node-v$NODE_VERSION-linux-$ARCH" /opt/node
fi
for b in node npm npx; do ln -sfn /opt/node/bin/$b /usr/local/bin/$b; done

echo "== the openhouse user and folders"
id openhouse >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin openhouse
# The USB microphone, for later (the wake word on the hub, docs/hub.md), and the network's devices need nothing more.
getent group audio >/dev/null && usermod -aG audio openhouse || true
mkdir -p "$DATA" && chown openhouse:openhouse "$DATA" && chmod 750 "$DATA"
# The keeper's user: in the openhouse group only to read the bridge's secret (.bridge-token, 0640), to hand the bridge
# what calendars and albums say. Its folder (beside the data folder, never inside it or in a backup) is its own, 0700:
# one made before it had a user of its own moves to it, seal key and all.
id openhouse-keeper >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin openhouse-keeper
usermod -aG openhouse openhouse-keeper
mkdir -p "$KEEPER_DIR" && chown -R openhouse-keeper:openhouse-keeper "$KEEPER_DIR" && chmod 700 "$KEEPER_DIR"
# Its token: the bridge reads it to call the keeper, which never answers back what it keeps.
token() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
mkdir -p /etc/openhouse
[ -s "$KEEPER_TOKEN" ] || (umask 077 && token > "$KEEPER_TOKEN")
chown openhouse-keeper:openhouse "$KEEPER_TOKEN" && chmod 440 "$KEEPER_TOKEN"
[ -s "$DATA/.bridge-token" ] || (umask 077 && token > "$DATA/.bridge-token")
chown openhouse:openhouse "$DATA/.bridge-token" && chmod 640 "$DATA/.bridge-token"
if [ -d "$CODE/.git" ]; then echo "(keeping the checkout in $CODE)"; else
  rm -rf "$CODE"; git clone --branch "$BRANCH" "$REPO" "$CODE"
  # The newest release (a v* tag on that branch), not whatever is on it right now; updates go tag to tag (hub/update.sh).
  TAG=$(git -C "$CODE" tag -l 'v*' --merged HEAD --sort=-v:refname | head -1)
  [ -z "$TAG" ] || git -C "$CODE" reset -q --hard "$TAG"
fi
chown -R openhouse:openhouse "$CODE"
sudo -u openhouse git config --global user.name Display
sudo -u openhouse git config --global user.email display@localhost

echo "== building (a few minutes on a Pi)"
sudo -u openhouse env HOME="$DATA" PATH="/opt/node/bin:$PATH" bash "$CODE/hub/build.sh"

echo "== the keeper's code (root's own copy, from the newest release itself)"
# Never from $CODE, which the openhouse user can change (and git as root won't run in another user's repo anyway).
KT=$(git ls-remote --tags --refs "$REPO" 'v*' | sed 's#.*refs/tags/##' | sort -V | tail -1)
KS=$(mktemp -d); git clone -q --depth 1 ${KT:+--branch "$KT"} "$REPO" "$KS/src"
rm -rf "$KEEPER_CODE.new" && mkdir -p "$KEEPER_CODE.new/hub" "$KEEPER_CODE.new/bridge"
cp "$KS/src/hub/keeper.mjs" "$KS/src/hub/s3.mjs" "$KEEPER_CODE.new/hub/" && cp "$KS/src/bridge/app-web.js" "$KEEPER_CODE.new/bridge/"
rm -rf "$KS"
echo '{"type":"module"}' > "$KEEPER_CODE.new/package.json"
chown -R root:root "$KEEPER_CODE.new" && chmod -R go-w "$KEEPER_CODE.new"
rm -rf "$KEEPER_CODE" && mv "$KEEPER_CODE.new" "$KEEPER_CODE"

echo "== the service"
[ -f /etc/default/openhouse ] || cat > /etc/default/openhouse <<'CONF'
# Opie hub settings (docs/hub.md). Restart after a change: sudo systemctl restart openhouse
# Backups to a USB drive or a share mounted here (default: /var/lib/openhouse/backups):
#OPENHOUSE_BACKUP_DIR=/media/backup
# https on the home network, for live voice in phone browsers:
#HUB_TLS_CERT=/var/lib/openhouse/tls/cert.pem
#HUB_TLS_KEY=/var/lib/openhouse/tls/key.pem
CONF
cat > /etc/systemd/system/openhouse-keeper.service <<UNIT
[Unit]
Description=Opie hub keeper
After=network-online.target
Wants=network-online.target

[Service]
User=openhouse-keeper
Environment=OPENHOUSE_DATA=$DATA OPENHOUSE_KEEPER_DIR=$KEEPER_DIR OPENHOUSE_KEEPER_STORE=file KEEPER_PORT=$KEEPER_PORT BRIDGE_URL=http://127.0.0.1:8787
Environment=OPENHOUSE_KEEPER_TOKEN_FILE=$KEEPER_TOKEN OPENHOUSE_TOKEN_FILE=$DATA/.bridge-token
ExecStart=/opt/node/bin/node $KEEPER_CODE/hub/keeper.mjs
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$KEEPER_DIR
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/openhouse.service <<UNIT
[Unit]
Description=Opie hub
After=network-online.target openhouse-keeper.service
Wants=network-online.target openhouse-keeper.service

[Service]
User=openhouse
Environment=OPENHOUSE_DATA=$DATA OPENHOUSE_CODE_DIR=$CODE OPENHOUSE_INSTALL=git HOME=$DATA PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=OPENHOUSE_KEEPER=http://127.0.0.1:$KEEPER_PORT OPENHOUSE_KEEPER_TOKEN_FILE=$KEEPER_TOKEN OPENHOUSE_KEEPER_DIR=$KEEPER_DIR
EnvironmentFile=-/etc/default/openhouse
ExecStart=$CODE/hub/start.sh
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable openhouse-keeper openhouse >/dev/null
systemctl restart openhouse-keeper openhouse

echo "== waiting for it"
for i in $(seq 1 60); do [ -s "$DATA/hub-setup.txt" ] && break; curl -fsS -o /dev/null http://127.0.0.1:8788/hub/ 2>/dev/null && break; sleep 1; done
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
if [ -s "$DATA/hub-setup.txt" ]; then sed "s#<this machine's address>#${IP:-this machine}#" "$DATA/hub-setup.txt"; else echo "It's running: open http://${IP:-this machine}:8788/hub/ on a settings device."; fi
echo "Logs: journalctl -u openhouse -f"
