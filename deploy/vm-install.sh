#!/usr/bin/env bash
# ============================================================
# deploy/vm-install.sh — native install on an always-on Linux VM
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/deploy/vm-install.sh | sudo bash
#   # or, from a checkout:
#   sudo bash deploy/vm-install.sh
#
# Tested on Ubuntu 22.04/24.04 (Oracle Cloud Always Free, Hetzner,
# Contabo, RackNerd, any KVM VPS). Installs Node 20 from NodeSource,
# copies the checkout to /opt/minecraft-afk-bot, installs production
# dependencies, and runs the bot under systemd with Restart=always.
#
# Why a VM instead of a free PaaS: nothing here spins down, sleeps,
# counts instance hours or suspends an account for staying awake.
# ============================================================
set -euo pipefail

APP_DIR="/opt/minecraft-afk-bot"
APP_USER="afkbot"
NODE_MAJOR="20"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "run me with sudo" >&2
  exit 1
fi

echo "==> installing Node ${NODE_MAJOR} and git"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates git
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "==> creating ${APP_USER}"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

echo "==> copying the app to ${APP_DIR}"
mkdir -p "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  # node_modules is rebuilt below; .git and tests are not needed at runtime.
  tar -C "$SRC_DIR" \
    --exclude=.git --exclude=node_modules --exclude=tests --exclude=deploy \
    -cf - . | tar -C "$APP_DIR" -xf -
fi

echo "==> installing production dependencies"
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev

echo "==> installing the systemd unit"
install -m 0644 "$SRC_DIR/deploy/minecraft-afk-bot.service" /etc/systemd/system/minecraft-afk-bot.service
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

systemctl daemon-reload
systemctl enable --now minecraft-afk-bot

echo
echo "==> done. The dashboard is on http://<this-host>:5000"
echo "    journalctl -u minecraft-afk-bot -f     # live logs"
echo "    systemctl restart minecraft-afk-bot   # restart"
echo
echo "Open port 5000 in the host's firewall if you want the dashboard"
echo "from outside (Oracle: add an ingress rule to the VCN security list)."
