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
a host you have to trick into staying awake. Below are four honest shapes of
"free" for this bot. None of them has *literally* no limits — if a host says
unlimited and $0, read the resource number.

| Host | Signup | Card | 24/7 allowed | RAM | The catch |
| --- | --- | --- | --- | --- | --- |
| **Botkeep** | email, 2 minutes | no | **yes, that is what it is for** | 512 MB | 1 server slot; panel-only, no shell |
| **Other bot panels** (HeavenCloud, SillyDev, Waifly, VisiHost) | email / Discord | no | **yes** | 256–512 MB | some require a click every 4–7 days |
| **Oracle Cloud Always Free** | email + card verification | yes (₹0 charged) | **yes** | up to 24 GB ARM | signup rejected sometimes; ARM capacity can be full |
| **Old Android phone + Termux** | none | no | **yes, while the phone is on** | whatever the phone has | phone must stay charging on Wi-Fi |
| **Cheap VPS** (RackNerd, Hetzner, Contabo, VisiHost India) | email + UPI/card | yes | **yes** | 512 MB–4 GB | costs ₹99–250/month |
| Koyeb free | GitHub | card hold ($29) since Feb 2026 | scales to zero after 1 h idle | 512 MB | same trap as Render, plus a card hold |

**What this bot needs** (measured, not guessed): ~70 MB idle, ~100–130 MB after
`minecraft-data` loads, one outbound TCP connection to the Minecraft server. That
fits 512 MB comfortably and 256 MB tightly.

---

## 1. Botkeep — step by step

Botkeep (`botkeep.cloud`) is a European panel built for always-on apps and bots.
The free plan is **1 server, 512 MB RAM, 50% CPU, 1 GB storage, running 24/7**,
no credit card, no renewal timer, no idle sleep. That is the closest thing to
"Render free without the spin-down" — you are not breaking any rule by leaving
the bot online, because staying online is the plan.

### 1.1 Create the account

1. Open `https://botkeep.cloud/register`.
2. Sign up with **email** (or Discord / GitHub). No card, no phone.
3. Confirm you land in the panel at `botkeep.cloud/app`.

### 1.2 Build the ZIP (only if you upload files)

Botkeep expects **`package.json` at the archive root** — not inside an extra
folder. GitHub's "Download ZIP" wraps everything in `repo-main/`, so re-zip the
contents:

```powershell
# Windows PowerShell, after extracting the GitHub ZIP
Compress-Archive -Path .\aternosminecraftserverbot-main\* -DestinationPath afk-bot.zip -Force
```

```bash
# Linux / macOS, from a git clone
cd aternosminecraftserverbot && zip -r ../afk-bot.zip . -x 'node_modules/*' '.git/*' 'tests/*'
```

Check before uploading: opening `afk-bot.zip` must show `package.json`,
`index.js`, `settings.json`, `probe.js`, `watcher.js`, `provider.js`,
`leaveRejoin.js`, `logger.js` — and no `node_modules`.

> Prefer GitHub? In the creation form choose **GitHub**, connect the Botkeep
> GitHub App, pick the repo and `main`. Branch deployments are a revision, not a
> live sync, so press deploy after each push.

### 1.3 Create the server

In the panel: **Create / New server** → runtime **Node.js** → version **Node 22**
(this repo supports `>=20 <23`; 24 is outside the range, so don't pick it) →
source **ZIP** (upload `afk-bot.zip`) or **GitHub**.

Set the resources: the free pool is a total of 512 MB / 50% CPU / 1 GB, and one
server may take all of it — give this one **512 MB, 50% CPU, ~1 GB**.

Start command, exactly:

```
npm start
```

(`package.json` maps that to `node index.js`. Botkeep runs `npm` from the
lockfile, so dependencies install on the build step — you do not run
`npm install` yourself.)

### 1.4 Environment variables

In the server's **Environment / Secrets** tab add one variable:

```
NODE_OPTIONS=--max-old-space-size=384
```

That keeps V8 under the 512 MB cap so a memory problem shows up as a clear Node
error instead of the panel OOM-killing the process.

**Do not set `PORT`.** Botkeep assigns a random port and passes it as
`SERVER_PORT`; this repo now reads that automatically (see `resolveHttpPort` in
`index.js`). Hard-coding `PORT=5000` is what makes panel apps show up as offline
with a `503`.

Optional, if you want to change the Minecraft target without editing files:

```
MC_SERVER_HOST=your-server.aternos.me
MC_SERVER_PORT=39033
MC_USERNAME=OfflinePlayer
```

**Do not set `PUBLIC_URL` or `SELF_PING_INTERVAL_MS`.** Nothing spins down here,
and the self-ping is exactly what got the Render accounts banned.

### 1.5 Start it

1. Press **Start** and open the **Console** tab.
2. You should see, in order:
   ```
   [Config] Server:  ZLAG.aternos.me:39033
   [Config] Account: OfflinePlayer (offline)
   [Lease] Acquired /tmp/...
   [Server] Dashboard listening on http://0.0.0.0:<assigned port>
   [Boot] Bot started
   [Probe] Not ready (offline (ECONNREFUSED)) — probe 1/6 before forcing a login
   ```
3. `Not ready` means Aternos is asleep — normal. Start the Aternos server in its
   own panel; the bot joins by itself when the port answers (probes every few
   seconds, forced login after 6).

### 1.6 The dashboard

Botkeep runs the process on a random port and can route a domain to it:

* **Network** tab → the assigned port. The dashboard is on
  `http://<node>.botkeep.cloud:<port>` (e.g. `node6.botkeep.cloud:45009`).
* **Domains** tab → add a domain if you want HTTPS; point the app at the same
  port.
* If the port does not answer from outside, the **Console** is your dashboard:
  same log lines, same reconnect messages, same Start/Stop in the panel.

### 1.7 Updating the bot

Edit `settings.json` directly in the panel's **Files** tab (server IP, port,
username), or re-upload a new ZIP as a new revision. Keep your own copy of the
project — a hosting backup is not source control.

---

## 2. Other bot panels (Pterodactyl-based)

HeavenCloud (512 MB), SillyDev (256 MB), Waifly (300 MB), VisiHost/NexCloud
(India, 256 MB). These are Pterodactyl, so there is no build step — you run
npm yourself:

1. Sign up (email / Discord, no card).
2. Create a server → **Node.js** egg, **Node 22**.
3. Upload the repo ZIP in **File Manager**, then in the console:
   ```
   unzip *.zip && mv aternosminecraftserverbot-main/* .
   npm ci --omit=dev || npm install --omit=dev
   ```
4. Startup file `index.js`, startup command `node index.js`.
5. Environment: `NODE_OPTIONS=--max-old-space-size=384` (or `192` on a 256 MB panel).
6. Start, and watch the console.

These panels give no public URL at all, so the console is your dashboard. If a
256 MB panel gets OOM-killed while `minecraft-data` loads 1.21, that is the
panel's RAM, not the bot — use Botkeep (512 MB) instead.

---

## 3. Oracle Cloud Always Free — the genuinely unlimited one

Real VM, free forever, no sleep, no instance-hour accounting, 4 ARM cores and up
to 24 GB of RAM. You need a card to verify identity (₹0 charged; a temporary hold
may appear).

1. Sign up at `cloud.oracle.com` → **Always Free**.
2. **Create instance** → image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**,
   1 OCPU / 6 GB is plenty. Pick the nearest region (Mumbai or Hyderabad).
   * If ARM capacity is "out of stock", retry later, try another availability
     domain, or use the AMD `VM.Standard.E2.1.Micro` (1 GB, also always free).
3. Networking → the VCN's **security list** → add an ingress rule:
   source `0.0.0.0/0`, TCP, destination port **5000**. Without it the dashboard
   is unreachable even though the bot runs.
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

## 4. An old Android phone + Termux — no signup at all

If you have a spare phone, this beats every cloud free tier: no account, no
card, no ToS, no instance hours, nobody can suspend you. It only needs to stay
charging with Wi-Fi on. 2 GB of RAM is enough.

```
pkg install git
git clone <your repo> ~/afk-bot
bash ~/afk-bot/deploy/termux-install.sh
```

The script installs Node LTS, runs `npm ci`, takes a `termux-wake-lock`
(otherwise Android freezes the process as soon as the screen goes off) and prints
the `tmux` command to keep it running after you close Termux.

Also: Android settings → Apps → Termux → Battery → **Unrestricted**. Without
that, the OS kills it overnight.

---

## 5. A ₹99/month VPS — no limits, no games

If "no limit" matters more than "$0", this is the honest answer: RackNerd
(~$11/year), Hetzner (~€3.79/month), Contabo, or VisiHost in India. UPI works on
most of them. Same two commands as the Oracle VM:

```
git clone <your repo> && cd <repo>
sudo docker compose up -d --build
```

No spin-down, no cold start, no suspension for staying awake, and the dashboard
is yours.

---

## What not to do on the next host

* **Do not deploy this on another PaaS free tier with the self-ping on.** Render,
  Koyeb and Fly all treat permanently warming a sleeping service as abuse. It is
  the exact behaviour that cost you three accounts.
* **Do not create a second account** to get a second free service. One account,
  one bot.
* **Do not run two copies** with the same username. The `/tmp` lease only
  protects one machine; the second copy causes duplicate-login kicks.
* **Do not hard-code `PORT`** on a panel host — bind the port it assigned
  (`SERVER_PORT`), or the panel reports the app as offline.
* **Do not pick a 256 MB panel** and then wonder why 1.21 crashes: check the
  memory number before signing up and set `NODE_OPTIONS`.

## Which one should you pick?

* Want it working in 10 minutes, no card → **Botkeep** (512 MB, no renewals).
* Have a spare Android phone → **Termux**; free forever, nobody can take it away.
* Want a real VM and a dashboard on a public URL → **Oracle Always Free**, or a
  **₹99 VPS** if the Oracle signup rejects you.
