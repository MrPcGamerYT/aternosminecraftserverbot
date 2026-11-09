#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# deploy/termux-install.sh — run the bot on an old Android phone
#
#   pkg install git
#   git clone <your repo> ~/afk-bot
#   bash ~/afk-bot/deploy/termux-install.sh
#
# No account, no card, no signup, no instance hours and nothing that
# can suspend you: it is your own device. The trade-off is the phone
# must stay on, charging, with Wi-Fi and Termux alive.
#
# A phone with 2 GB of RAM is enough — the bot idles around 70 MB and
# reaches ~100–130 MB after minecraft-data loads.
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> installing Node.js LTS and git in Termux"
pkg update -y
pkg install -y nodejs-lts git

echo "==> Node $(node -v)"
case "$(node -p 'process.versions.node.split(".")[0]')" in
  20|21|22) ;;
  *) echo "this repo needs Node 20-22; 'pkg install nodejs-lts' now gives 24 — use 'pkg install nodejs' or a proot distro" >&2 ;;
esac

echo "==> installing production dependencies"
cd "$REPO_DIR"
npm ci --omit=dev || npm install --omit=dev

echo "==> keeping Android from sleeping Termux"
# Without this the OS freezes the process when the screen goes off and the
# bot drops out of the server.
termux-wake-lock || echo "  (termux-wake-lock unavailable — install termux-api)"

cat <<EOF

==> done.

Start it in a way that survives the terminal closing:

    cd $REPO_DIR
    tmux new -d -s afk 'node index.js'     # pkg install tmux
    tmux attach -t afk                       # watch it

Dashboard: http://<phone-ip-on-your-wifi>:5000
Also turn off battery optimisation for Termux in Android settings, or
the system will kill it after a while anyway.

EOF
