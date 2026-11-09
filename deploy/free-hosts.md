# Free hosts that will actually keep this bot online

Render suspended three of your accounts. That was not random, and it is worth
understanding before picking the next host — otherwise the next account dies the
same way.

Two things got those accounts flagged:

1. **The self-ping.** Render's free tier sleeps a service after 15 idle minutes.
   `SELF_PING_INTERVAL_MS=240000` calls `/ping` every 4 minutes precisely so that
   sleep never happens. Render's own answer to "my free service sleeps" is *move
   to a paid instance*; keeping a free service permanently awake is using an
   evaluation tier as a free VPS. Their free docs say: *do not use free instances
   for production applications.*
2. **Three accounts.** One free service per workspace is the allowance. A second
   and third account to get more free compute is ban evasion on its own, even
   without the pinging.

So the rule for the next host is: **pick a host where 24/7 is the product**, not
a host you have to trick into staying awake. There are four honest shapes of
"free" for this bot. None of them has *literally* no limits — if a host says
unlimited and $0, read the resource number.

---

## The options, side by side

| Host | Signup | Card | 24/7 allowed | RAM | The catch |
| --- | --- | --- | --- | --- | --- |
| **Bot panel** (Botkeep, HeavenCloud, SillyDev, Waifly, VisiHost, NexCloud) | email / Discord, 2 minutes | no | **yes, that is what it is for** | 256–512 MB | no public dashboard URL; small RAM; some require a click every 4–7 days |
| **Oracle Cloud Always Free** | email + card verification | yes (₹0 charged) | **yes** | up to 24 GB ARM | signup gets rejected sometimes; ARM capacity can be full in a region |
| **Old Android phone + Termux** | none | no | **yes, while the phone is on** | whatever the phone has | the phone must stay charging on Wi-Fi |
| **Cheap VPS** (RackNerd, Hetzner, Contabo, VisiHost India) | email + UPI/card | yes | **yes** | 512 MB–4 GB | costs ₹99–250/month, not free |
| Koyeb free | GitHub | card hold ($29) since Feb 2026 | scales to zero after 1 h idle | 512 MB | same trap as Render, plus a card hold |
| Railway / Fly.io | email | yes | trial credit only | 512 MB | no real free tier left in 2026 |

**What this bot needs** (measured, not guessed): ~70 MB idle, ~100–130 MB after
`minecraft-data` loads, one outbound TCP connection to the Minecraft server.
That fits in 512 MB comfortably, 256 MB tightly, 300 MB fine.

---

## 1. A free bot panel — easiest, no card

These are Pterodactyl panels that give away small always-on containers to run
bots. 24/7 is the point of the product, so leaving it running is not abuse. They
are aimed at Discord bots, but the runtime is just "Node.js, your files, `npm
start`" — a Minecraft client is outbound TCP like any other.

Working options (2026):

| Panel | Free RAM | Renewals | Notes |
| --- | --- | --- | --- |
| **Botkeep** (`botkeep.cloud`) | 512 MB, 50% CPU, 1 GB disk | none | no card, no Discord account needed |
| **HeavenCloud** (`heavencloud.in`) | 512 MB, 25% CPU, 712 MB disk | click every 7 days | no card, Miami/Houston/Falkenstein |
| **SillyDev** (`sillydev.co.uk`) | 256 MB, 25% CPU | none | no card, no sleep |
| **Waifly** (`waifly.com`) | 300 MB, 30% CPU | none (suspended if offline 3 days) | Paris |
| **VisiHost / NexCloud** (India) | 256 MB | varies | Indian support, Hindi/English |

### Steps

1. Sign up with an email address. No card.
2. Create a server → choose a **Node.js** egg, **Node 22** if offered
   (this repo supports Node 20–22; `engines` is `>=20 <23`).
3. Get the code onto the panel. The panel has no `git`, so:
   * on GitHub: **Code → Download ZIP**;
   * upload it in the panel's **File Manager**;
   * in the panel console: `unzip *.zip && mv aternosminecraftserverbot-main/* . 2>/dev/null; ls`
4. Install dependencies in the console:
   ```
   npm ci --omit=dev || npm install --omit=dev
   ```
5. Set the startup file to **`index.js`** and the startup command to **`node index.js`**.
6. Add one environment variable so Node stays inside the panel's memory cap:
   * 256 MB panel → `NODE_OPTIONS=--max-old-space-size=192`
   * 512 MB panel → `NODE_OPTIONS=--max-old-space-size=384`
7. Press **Start** and watch the console.

**The one real downside:** a bot panel gives you no public URL, so the dashboard
(`/`, `/logs`, `/start`) is not reachable from a browser. Your UI is the panel
console — the same log lines, the same reconnect messages. The bot itself runs
exactly as it does on Render.

If a 256 MB panel gets OOM-killed when `minecraft-data` loads 1.21, that is the
panel, not the bot: use Botkeep/HeavenCloud (512 MB) or the dashboard-less
alternative below.

---

## 2. Oracle Cloud Always Free — the genuinely unlimited one

Real VM, free forever, no sleep, no instance-hour accounting, 4 ARM cores and up
to 24 GB of RAM. This is the closest thing to "free with no limits" that exists.
You do need a card to verify identity (₹0 charged; a temporary hold may appear).

1. Sign up at `cloud.oracle.com` → **Always Free**.
2. **Create instance** → image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**,
   1 OCPU / 6 GB is plenty. Pick the region nearest you (Mumbai or Hyderabad).
   * If ARM capacity is "out of stock", retry later, try the other availability
     domain, or use the AMD `VM.Standard.E2.1.Micro` (1 GB, also always free).
3. Networking → the VCN's **security list** → add an ingress rule:
   source `0.0.0.0/0`, TCP, destination port **5000**. Without it the dashboard
   is unreachable even though the bot is running.
4. SSH in and deploy, either way:

   ```
   # A. Docker (recommended)
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
   git clone <your repo> afk-bot && cd afk-bot
   sudo docker compose up -d --build

   # B. Native + systemd
   git clone <your repo> afk-bot && cd afk-bot
   sudo bash deploy/vm-install.sh
   ```

5. Open `http://<public-ip>:5000`. That is the whole deployment.

`docker-compose.yml` and `deploy/minecraft-afk-bot.service` both use
`restart: always`, so a crash, a reboot or an OOM kill brings the bot straight
back — which is what Render's free tier kept undoing.

---

## 3. An old Android phone + Termux — no signup at all

If you have a spare phone, this beats every cloud free tier: no account, no
card, no ToS, no instance hours, no one can suspend you. It only needs to stay
charging with Wi-Fi on. 2 GB of RAM is enough.

```
pkg install git
git clone <your repo> ~/afk-bot
bash ~/afk-bot/deploy/termux-install.sh
```

The script installs Node LTS, `npm ci`, takes a `termux-wake-lock` (otherwise
Android freezes the process as soon as the screen goes off) and prints the
`tmux` command to keep it running after you close Termux.

Also: Android settings → Apps → Termux → Battery → **Unrestricted**. Without
that, the OS kills it overnight.

---

## 4. A ₹99/month VPS — no limits, no games

If "no limit" matters more than "$0", this is the honest answer: RackNerd
(~$11/year), Hetzner (~€3.79/month), Contabo, or VisiHost in India. UPI works on
most of them. Same two commands as the Oracle VM:

```
git clone <your repo> && cd <repo>
sudo docker compose up -d --build
```

No spin-down, no cold start, no account suspension for staying awake, and the
dashboard is yours.

---

## What not to do on the next host

* **Do not deploy this on another PaaS free tier and leave the self-ping on.**
  Render, Koyeb and Fly all treat permanently warming a sleeping service as
  abuse. It is the exact behaviour that cost you three accounts.
* **Do not create a second account** to get a second free service. One account,
  one bot.
* **Do not run two copies** of the bot with the same username. The `/tmp` lease
  only protects one machine; the second copy causes duplicate-login kicks.
* **Do not pick a 256 MB panel** and then wonder why 1.21 crashes: check the
  memory number before signing up, and set `NODE_OPTIONS`.

## Which one should you pick?

* Want it working in 10 minutes, no card → **Botkeep or HeavenCloud** (512 MB).
* Have a spare Android phone → **Termux**, it is free forever and nobody can
  take it away.
* Want a real VM, dashboard on a public URL, no limits → **Oracle Always Free**,
  or a **₹99 VPS** if the Oracle signup rejects you.
