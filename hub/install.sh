#!/bin/bash
# Install Opie as a hub on any Debian or Ubuntu machine, arm64 or x86_64: a Raspberry Pi, a NUC, an old laptop,
# Ubuntu under WSL on Windows. docs/hub.md
#   curl -fsSL https://raw.githubusercontent.com/mrubens/opie/main/hub/install.sh | sudo bash
#   or from a checkout: sudo hub/install.sh
# Installs git and Node 22, puts Opie in /opt/openhouse (a git checkout, so the settings page can update it),
# builds it, and runs it as the openhouse service with its data in /var/lib/openhouse. Run again to repair or update.
set -euo pipefail
REPO=${OPENHOUSE_REPO:-https://github.com/mrubens/opie.git}
BRANCH=${OPENHOUSE_BRANCH:-main}
CODE=/opt/openhouse DATA=/var/lib/openhouse NODE_VERSION=22.23.4
[ "$(id -u)" = 0 ] || { echo "Run it with sudo."; exit 1; }

echo "== packages"
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends git ca-certificates curl xz-utils zip procps

echo "== Node $NODE_VERSION"
case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) echo "Not a machine this runs on: $(uname -m)"; exit 1 ;; esac
if ! /opt/node/bin/node -v 2>/dev/null | grep -q "^v$NODE_VERSION$"; then
  rm -rf /opt/node "/opt/node-v$NODE_VERSION-linux-$ARCH"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" | tar -xJ -C /opt
  ln -sfn "/opt/node-v$NODE_VERSION-linux-$ARCH" /opt/node
fi
for b in node npm npx; do ln -sfn /opt/node/bin/$b /usr/local/bin/$b; done

echo "== the openhouse user and folders"
id openhouse >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin openhouse
# The USB microphone, for later (the wake word on the hub, docs/hub.md), and the network's devices need nothing more.
getent group audio >/dev/null && usermod -aG audio openhouse || true
mkdir -p "$DATA" && chown openhouse:openhouse "$DATA" && chmod 750 "$DATA"
# The keeper's folder (hub/keeper.mjs): beside the data folder, never inside it or in a backup.
mkdir -p "$DATA-keeper" && chown openhouse:openhouse "$DATA-keeper" && chmod 700 "$DATA-keeper"
if [ -d "$CODE/.git" ]; then echo "(keeping the checkout in $CODE)"; else
  rm -rf "$CODE"; git clone --branch "$BRANCH" "$REPO" "$CODE"
fi
chown -R openhouse:openhouse "$CODE"
sudo -u openhouse git config --global user.name Display
sudo -u openhouse git config --global user.email display@localhost

echo "== building (a few minutes on a Pi)"
sudo -u openhouse env HOME="$DATA" PATH="/opt/node/bin:$PATH" bash "$CODE/hub/build.sh"

echo "== the service"
[ -f /etc/default/openhouse ] || cat > /etc/default/openhouse <<'CONF'
# Opie hub settings (docs/hub.md). Restart after a change: sudo systemctl restart openhouse
# Backups to a USB drive or a share mounted here (default: /var/lib/openhouse/backups):
#OPENHOUSE_BACKUP_DIR=/media/backup
# https on the home network, for live voice in phone browsers:
#HUB_TLS_CERT=/var/lib/openhouse/tls/cert.pem
#HUB_TLS_KEY=/var/lib/openhouse/tls/key.pem
CONF
cat > /etc/systemd/system/openhouse.service <<UNIT
[Unit]
Description=Opie hub
After=network-online.target
Wants=network-online.target

[Service]
User=openhouse
Environment=OPENHOUSE_DATA=$DATA OPENHOUSE_CODE_DIR=$CODE OPENHOUSE_INSTALL=git HOME=$DATA PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
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
systemctl enable openhouse >/dev/null
systemctl restart openhouse

echo "== waiting for it"
for i in $(seq 1 60); do [ -s "$DATA/hub-setup.txt" ] && break; curl -fsS -o /dev/null http://127.0.0.1:8788/hub/ 2>/dev/null && break; sleep 1; done
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
if [ -s "$DATA/hub-setup.txt" ]; then sed "s#<this machine's address>#${IP:-this machine}#" "$DATA/hub-setup.txt"; else echo "It's running: open http://${IP:-this machine}:8788/hub/ on a settings device."; fi
echo "Logs: journalctl -u openhouse -f"
