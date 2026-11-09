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

### 1.0 Which profile do I pick?

The creation form asks what you are deploying. Only one answer runs this bot:

| Profile in the wizard | Pick it? | Why |
| --- | --- | --- |
| **Application / Bot** (Node.js) | **yes** | runs one long-lived Node process — that is exactly what this bot is |
| **Website** (static HTML/CSS/JS) | no | a static site has no Node process, no Minecraft socket, nothing that can stay connected |
| **Database** (MySQL / PostgreSQL / Redis) | no | the bot stores nothing in a database, and it would spend your only free slot |
| **Service** (Lavalink, Uptime Kuma) | no | those are prebuilt apps, not your code |

So: **Application / Bot → Node.js**. Everything below assumes that choice.

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

> Prefer not to zip anything? **GitHub works too** — see 1.3.

### 1.3 Connect the repo directly (GitHub) or upload the ZIP

**Yes, a direct repo connection works.** In the creation form choose **GitHub**,
install the Botkeep GitHub App for this one repository, then pick:

| Field | Value |
| --- | --- |
| Repository | `MrPcGamerYT/aternosminecraftserverbot` |
| Branch | `main` |
| Project root | `/` (the repo root — `package.json` is there, no subfolder) |
| Runtime | **Node.js 22** (this repo supports `>=20 <23`; 24 is outside the range) |
| Start command | `npm start` |
| Resources | 512 MB RAM, 50% CPU, ~1 GB — the whole free pool |

Three things about a GitHub connection on a panel host:

1. **A deploy is a revision, not live sync.** After `git push` nothing changes on
   the host until you open the panel and deploy/apply the new revision. (Botkeep
   can do pull-on-start and push updates, but only if you explicitly enable them.)
2. **A redeploy resets files you edited in the panel.** If you fix the server IP
   in the **Files** tab, the next GitHub deploy overwrites it with the repo
   version. So either set the target in `settings.json` in the repo and push, or
   use the environment variables in 1.5 — those survive redeploys.
3. **`node_modules` must stay out of the repo** (this one is already in
   `.gitignore`); the build installs from `package-lock.json`.

ZIP instead? See 1.2 — the only trap there is the outer folder.

### 1.4 Start command and resources

```
npm start
```

(`package.json` maps that to `node index.js`. Botkeep installs from the lockfile
on the build step, so you never run `npm install` by hand.)

Give the one server the whole free pool: **512 MB RAM, 50% CPU, ~1 GB**.

### 1.5 Environment variables

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

### 1.5b Node version on a panel: pick 20 or 22, never 24/25

Panel eggs often default to the newest Node they have (SillyDev ships Node 25).
This repo declares `engines: ">=20 <23"` and mineflayer is untested above 22 —
you will see `npm warn EBADENGINE` and, on some hosts, a connect/reconnect loop
that looks like a network problem.

* Pterodactyl: **Startup** tab → look for a Node version variable (`NODE_VERSION`,
  `NODE_JS_VERSION`) or a "Node.js 22" egg. Restart after changing it.
* Botkeep: pick **Node.js 22** in the creation form.
* Can't change it? Ask support for Node 22. A last resort is a local binary:
  `npm install node@22 --no-save` then set the startup command to
  `./node_modules/.bin/node index.js` (costs ~50 MB of your disk).

### 1.6 Start it

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

### 1.7 The dashboard

Botkeep runs the process on a random port and can route a domain to it:

* **Network** tab → the assigned port. The dashboard is on
  `http://<node>.botkeep.cloud:<port>` (e.g. `node6.botkeep.cloud:45009`).
* **Domains** tab → add a domain if you want HTTPS; point the app at the same
  port.
* If the port does not answer from outside, the **Console** is your dashboard:
  same log lines, same reconnect messages, same Start/Stop in the panel.

### 1.8 "No server capacity is available at the moment"

That message comes from Botkeep, not from this repo — their **free tier is
oversubscribed**, so the creation call is refused when no node has a free slot.
Your account is fine and nothing was created; there is nothing to undo.

What actually helps:

* **Retry later.** Free capacity frees up when other people delete servers, so
  the same click works a few hours later. Off-peak (European night, ~22:00–04:00
  UTC) is the best window.
* **Retry with a smaller allocation** if the form lets you choose: 384 MB instead
  of 512 MB fits in tighter gaps, and this bot runs comfortably in 256–384 MB.
* **Check [`status.botkeep.cloud`](https://status.botkeep.cloud/) → "Server
  creation".** If that probe says unavailable, waiting is the only option; if it
  says available while you still get refused, it is free-plan capacity.
* **Do not create a second account** to "get a slot" — that is the ban-evasion
  pattern that already cost three Render accounts.

If it keeps failing, the sections below are the queue-free alternatives: Oracle
Always Free (a real VM) and an old phone on Termux (no capacity to run out of).
The other panels in section 2 have the *same* capacity lottery, just a different
queue.

### 1.9 Updating the bot

Edit `settings.json` directly in the panel's **Files** tab (server IP, port,
username), or re-upload a new ZIP as a new revision. Keep your own copy of the
project — a hosting backup is not source control.

---

## 2. Other free bot panels (Pterodactyl-based)

When Botkeep says "no server capacity", the next stop is another free panel.
They all run the same Pterodactyl software, so the steps are identical — only
the signup flow and the renewal rule differ.

| Panel | Free RAM | Signup | Renewal | Note |
| --- | --- | --- | --- | --- |
| **HeavenCloud** (`heavencloud.in`) | 512 MB | Discord | click every 7 days | closest to Botkeep's free spec |
| **Waifly** (`waifly.com`) | 300 MB | email | none | suspended only if the server stays offline 3 days |
| **SillyDev** (`sillydev.co.uk`) | 256 MB | email | none | small, but enough for this bot |
| **FreeGameHost** (`freegamehost.xyz`) | 256 MB | email | click every 12 h (max 48 h) | Node.js egg, SFTP + console |
| **VisiHost / NexCloud** (India) | 256 MB | email / Discord | varies | nearest to you, Hindi support |

All of them are free, no card, and none of them sleeps an idle process — that is
the point of a bot panel. The capacity is small, so 256 MB panels need
`NODE_OPTIONS=--max-old-space-size=192`.

Steps (same on every one of them):

1. Sign up (email / Discord, no card).
2. Create a server → **Node.js** egg, **Node 22**.
3. Upload the repo ZIP in **File Manager**, then in the console:
   ```
   unzip *.zip && mv aternosminecraftserverbot-main/* .
   npm ci --omit=dev || npm install --omit=dev
   ```
4. Startup file `index.js`, startup command `node index.js`.
5. Environment: `NODE_OPTIONS=--max-old-space-size=384` (or `192` on a 256 MB
   panel).
6. Start, and watch the console.

These panels give no public URL at all, so the console is your dashboard. If a
256 MB panel gets OOM-killed while `minecraft-data` loads 1.21, that is the
panel's RAM, not the bot — move to a 512 MB panel or a VM.

**Northflank and Leapcell are not answers here**, even though they look free:
Northflank requires a payment method on every plan to create resources, and
Leapcell's free tier is serverless invocations with no persistent server — a
Minecraft session needs a process that stays alive.

---

## 2b. SillyDev, start to finish

SillyDev (`sillydev.co.uk`) is a Pterodactyl panel: no build step, you run npm in
its console. Free container, no card.

> **Node version:** its egg currently ships **Node 25**, which is outside this
> repo's `>=20 <23` range (`npm warn EBADENGINE`). It runs, but mineflayer is
> untested there — use the **Startup** tab's Node version variable or a "Node.js
> 22" egg if one is offered.

1. **Create the server** — Node.js egg, small RAM allocation (256 MB is enough
   for this bot; 512 MB is comfortable).
2. **Get the files in.** GitHub → **Code → Download ZIP**, upload it in **File
   Manager**, then in the **Console**:
   ```
   unzip *.zip
   mv aternosminecraftserverbot-main/* .
   npm install --omit=dev
   ```
   (Or, if the server is already set up, updating one file is enough:
   `curl -o index.js https://raw.githubusercontent.com/MrPcGamerYT/aternosminecraftserverbot/main/index.js`)
3. **Startup tab** — main file `index.js`, command `node index.js`.
4. **Environment** — `NODE_OPTIONS=--max-old-space-size=192` on a 256 MB server,
   `384` on 512 MB. Do **not** set `PORT` (the panel's `SERVER_PORT` is read
   automatically) and do **not** set `PUBLIC_URL`.
5. **Press Start.** The console is the dashboard:
   ```
   [Server] Dashboard listening on http://0.0.0.0:6158
   [Boot] Bot started
   [Probe] Not ready (port open, no status reply) — probe 1/6
   [Chat] OfflinePlayer joined the game
   [Bot] Spawned in ... (version 1.21.1)
   ```
   `Not ready` probes are Aternos still booting; after 6 probes the bot forces a
   login, which is why it joins even then.
6. **The session must stay up.** If you see `[Watchdog] Socket silent for ~92s`
   in a loop, that was the liveness bug fixed in `0b31854` — make sure
   `index.js` is the current one from `main`.

### Wiring the panel to a Vercel dashboard

The bot listens on the panel's assigned port (e.g. `6158`). For the vercel.app
page to show the live session, that port must be reachable from the internet:

1. Panel → **Network / Allocation** → copy the server address
   (`node-xx.sillydev.co.uk:6158` or `IP:6158`).
2. Open `http://<that address>/health` in a browser.
   * **JSON** → Vercel → Settings → Environment Variables →
     `BOT_BACKEND_URL=http://<that address>` → **Redeploy**. The Vercel page now
     proxies every request (status, logs, Start/Stop) to the bot.
   * **Timeout / refused** → the free panel does not expose HTTP ports. The
     console stays your dashboard; a public URL needs a VM (section 3 or 5).

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
