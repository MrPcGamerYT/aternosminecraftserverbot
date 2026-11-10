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

### Panels have no shell — doing "npm install" and "doctor" the right way

On SillyDev/Botkeep/Pterodactyl you **cannot** type `npm install` or `node doctor.js`
into the console while the server is running: that console is the *bot's* stdin,
so the command lands in the game chat handler and the reply is
`[Console] Bot is not connected yet.` (harmless, but it is not a shell).

What works instead:

| You want to run | How |
| --- | --- |
| `npm install` | It runs by itself on every start (`if [ -f /home/container/package.json ]; then npm install`). To force a clean one, use **File Manager → delete `node_modules`** → Start. |
| `node doctor.js` | Set `MAIN_FILE` to `doctor.js` in the Startup tab, press Start, read the output, then set it back to `index.js`. |
| a shell command | Only on a VM/VPS. A panel does not give you one. |

**`Cannot find module '../minecraft-data/data/pc/common/features.json'`** means
the dependency download was incomplete — an interrupted install, two installs at
once, or a full disk. Resolving the package still works, so nothing complains
until the bot tries to log in. Fix:

1. File Manager → delete the **`node_modules`** folder.
2. Start the server (the egg reinstalls), or on a VM: `npm run repair`.

`npm run doctor` now catches this before you press Start:
`[FAIL] Mineflayer loads: ... delete node_modules and reinstall`.

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
5. **Pre-flight, before you press Start:**
   ```
   node doctor.js
   ```
   It prints one line per check and tells you exactly what is wrong if it is not
   ready — files still inside an extra folder, `npm install` never run, Node 25,
   an empty target, or the port the panel assigned:
   ```
   [ ok ] Node version: v22.22.0
   [ ok ] Files: 8 required files at the project root
   [ ok ] Dependencies: express, mineflayer, minecraft-data resolved
   [ ok ] Minecraft target: ZLAG.aternos.me:39033 (1.21.1)
   [ ok ] Account: OfflinePlayer (offline)
   [ ok ] Dashboard port: 6158 from SERVER_PORT (panel)

   Ready to start. Run: npm start
   ```
6. **Press Start.** The console is the dashboard:
   ```
   [Server] Dashboard listening on http://0.0.0.0:6158
   [Boot] Bot started
   [Probe] Not ready (port open, no status reply) — probe 1/6
   [Chat] OfflinePlayer joined the game
   [Bot] Spawned in ... (version 1.21.1)
   ```
   `Not ready` probes are Aternos still booting; after 6 probes the bot forces a
   login, which is why it joins even then.
7. **The session must stay up.** If you see `[Watchdog] Socket silent for ~92s`
   in a loop, that was the liveness bug fixed in `0b31854` — make sure
   `index.js` is the current one from `main`.

### The public dashboard URL (SillyDev gives you one)

SillyDev's own FAQ: *"Your server gets a public address and port, shown in your
panel. Have your app listen on `0.0.0.0` and the port in the `SERVER_PORT`
environment variable, and it is reachable over plain HTTP straight away."*

That is exactly what this bot does, so:

1. Panel → **Network** tab → copy the address next to your allocation,
   e.g. `123.45.67.89:6219` or `node-08.sillydev.co.uk:6219`.
2. Open `http://<that address>` in a browser. That is the dashboard: status card,
   logs, Start/Stop/Restart, `/command`, tutorial.
3. **It is plain HTTP and it is public** — no domain, no certificate. Anyone with
   the URL can stop the bot or type into your Minecraft session, so protect it:

   ```
   DASHBOARD_PASSWORD=pick-a-long-password
   DASHBOARD_USER=admin
   ```

   Environment tab, then restart. The browser asks for the password; `/health`
   and `/ping` stay open so the panel's own checks keep working.

4. Want **HTTPS** and a real domain? Run Cloudflare Tunnel next to the app
   (SillyDev suggests the same thing) or put a reverse proxy in front, and point
   the domain at port `SERVER_PORT`.

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

## 9. More hosts, one table

Everything below runs this repo unchanged (`PORT` or `SERVER_PORT`, one process,
`npm start`). "Public URL" means the dashboard is reachable from a browser
without a tunnel.

| Host | Free? | Card? | Public URL | RAM | Verdict |
| --- | --- | --- | --- | --- | --- |
| **SillyDev** | yes, no expiry | no | **yes** — `IP:PORT`, plain HTTP | 256 MB | what you are on now; add `DASHBOARD_PASSWORD` |
| **alwaysdata** | yes, personal use | no | **yes** — HTTPS + `you.alwaysdata.net` | 256 MB / 1 GB disk | the only free host here with **HTTPS included**; Node site + this bot's web server fits |
| **Botkeep** | yes | no | yes, via Domains | 512 MB | best free RAM, but capacity is a queue |
| **Waifly** | yes | no | yes (`IP:PORT`) | 300 MB | no renewal clicks; suspended if offline 3 days |
| **HeavenCloud** | yes | no | yes (`IP:PORT`) | 512 MB | weekly renewal click |
| **FreeGameHost** | yes | no | yes (`IP:PORT`) | 256 MB | renewal every 12 h — worst upkeep |
| **Oracle Cloud** | always free | yes (₹0) | **yes** — real IP, HTTPS with Caddy | 24 GB | the "no limits" answer; signup sometimes refuses |
| **Northflank Sandbox** | yes | **yes, required** | yes, HTTPS | 512 MB+ | always-on and well run — needs a payment method on file |
| **Koyeb** | yes | card hold $29 | yes, HTTPS | 512 MB | scales to zero after 1 h idle — the Render trap again |
| **Zeabur** | $5/mo credit | no | yes, HTTPS | 512 MB | auto-sleeps when idle; credit runs out |
| **Railway** | $5 trial, then $1/mo credit | no for trial | yes, HTTPS | 512 MB | fine to test, not a 24/7 home |
| **Hetzner / RackNerd / VisiHost** | no | yes | yes | 2–4 GB | €3.79/mo, ~$11/year, or ₹99 — no queues, no rules |

### alwaysdata, in short

Free, no card, real HTTPS on a real domain — the one free option that fixes the
"plain HTTP, no certificate" awkwardness of a panel:

1. Sign up at `alwaysdata.com` (no card, personal use).
2. **Web → Sites → Add a site** → type **Node.js**, working directory the repo,
   command `node index.js`.
3. Upload the project (SSH/SFTP is included on the free plan), run
   `npm ci --omit=dev`.
4. Set `DASHBOARD_PASSWORD` and `NODE_OPTIONS=--max-old-space-size=192` in
   **Advanced → Environment**.
5. The site answers on `https://<account>.alwaysdata.net`.

`alwaysdata` assigns the port through the `PORT` variable, which this app already
reads — no extra configuration.

## 10. Even more hosts

### 512 MB free panels (the useful class)

This bot needs roughly 150 MB to run; 100 MB panels cannot hold it, so anything
under 256 MB is not worth trying.

| Host | Free RAM | CPU | Renewal | Notes |
| --- | --- | --- | --- | --- |
| **Lunafy** (`lunafy.run`) | **512 MB** | 0.5 vCPU | every 7 days, one click | best published free specs in this class |
| **HeavenCloud** (`heavencloud.in`) | **512 MB** | 25% | every 7 days | 712 MB disk, Miami/Houston/Falkenstein |
| **Daki** (`daki.cc`) | 512 MB | 50% | runtime extended by watching ads | no card |
| **Bot-Hosting.net** | 256 MB | 25% | every 4 days | 512 MB disk |
| **VisiHost / NexCloud** (India) | 256 MB | shared | varies | Hindi support, nearest region |
| **FreeGameHost** | 256 MB | 25% | every 12 h | worst upkeep of the list |
| ~~Pella~~ | 100 MB | 0.1 | — | **too small** — mineflayer will be OOM-killed |

All of them are Pterodactyl, so the steps in section 2 apply unchanged.

### Free VMs on the big clouds (card needed, but no sleep and no queue)

| Provider | Always-free shape | Card | Catch |
| --- | --- | --- | --- |
| **Oracle Cloud** | 4 ARM cores / 24 GB (Ampere A1) | yes, ₹0 charged | capacity can be full; signup sometimes refused |
| **Google Cloud** | `e2-micro`, 1 vCPU / 1 GB, 30 GB disk in `us-central1` / `us-west1` / `us-east1` | yes | one VM per month, US regions only, check current terms |
| **Azure** | `B1s`, 750 h/month for 12 months | yes | 12 months, not forever |
| **AWS** | `t3.micro` / `t4g.micro`, 750 h/month for 12 months | yes | 12 months, not forever |

Deploy on any of them with `sudo bash deploy/vm-install.sh` or
`sudo docker compose up -d --build` (section 3).

### Cheap paid, zero rules

| Provider | Price | What you get |
| --- | --- | --- |
| **SillyDev paid** | 75p/month | doubles the free allocation (512 MB) — same panel you already know |
| **Botkeep Plus** | €1.99/month | 3 GB RAM, 5 slots, no queue |
| **Hetzner** | €3.79/month | 2 GB / 1 vCPU, EU, real root |
| **RackNerd** | ~$11/year | 1 GB, US, the cheapest usable VPS |
| **VisiHost** (India) | ₹39–99/month | Mumbai/Noida nodes |

For a bot that must stay online, one of these removes every free-tier problem at
once: no queue, no spin-down, no renewal clicks, no ad watching, no suspension.

## 11. Suspensions: what actually gets this bot banned

Read this before you appeal anywhere, because the reason is usually visible in
your own configuration.

### SillyDev allows this bot. Really.

From their site: *"None of this is about ordinary bots. An AFK client, a chat
bridge or a helper bot on a server you are allowed to be on is exactly what this
page is for."* — [`sillydev.co.uk/minecraft-bot-hosting`](https://sillydev.co.uk/minecraft-bot-hosting).
Their ban list is DDoS tools, stressers, packet flooders, crash exploits and
"bot swarms that flood a server with fake players", plus, from the terms:
*"excessive spamming of any kind, including but not limited to chat messages,
commands, or connection requests"* and *"operating automated connections in a
manner that places undue strain on the Service or on third-party servers."*

So a silent AFK client is fine. Three things in a *default* copy of this repo
look like the banned list:

| What in the config | How a host reads it | Fix |
| --- | --- | --- |
| `utils."chat-messages"` with `repeat: true` and a gap under ~2 minutes, or a line like "I will Ban You!" | chat spam, and a fast way to get banned by the Minecraft server | keep gaps at 300 s or more, delete threats — `npm run doctor` checks both |
| A reconnect loop (the old 90 s watchdog bug, `probe-not-ready` storms) | "undue strain … on third-party servers" | update `index.js`; verified fixed in `0b31854` |
| Two servers, or a second account after a suspension | ban evasion — the account is terminated and so is the replacement | one account, one server |

`npm run doctor` now warns about the first one:
`[warn] Chat automation: repeating 5 message(s) every 120s — hosts and Minecraft
servers call this spam`.

### Chat: wanted, but at a human pace

Talking is the single most human-looking thing this bot does, and on a shared
server it is the difference between "someone is AFK" and "a bot is farming".
It is also the easiest way to look like a spambot, so the code does three things:

| Rule | Why |
| --- | --- |
| every gap is **60-140%** of `repeat-delay`, 5 s floor | a fixed 120 s timer is the clearest bot signature there is |
| a line is **never sent twice in a row** | round-robin through a 5-line list repeats visibly |
| `"only-when-players-online": true` | no monologues on an empty server, where nobody can read them anyway |

A setting that looks human on a small server:

```json
"chat-messages": {
  "enabled": true,
  "repeat": true,
  "repeat-delay": 420,
  "only-when-players-online": true,
  "messages": ["brb", "afk a bit", "lol", "back"]
}
```

That is a line every 4-10 minutes while someone else is online: nothing a host
would call spam, nothing a server would call a bot.

**Honest limit:** chat does not fool the hosting provider. Aternos decides about
AFK bots from connection behaviour and their own rules, not from whether the
account types "brb" — so a suspended Aternos server stays suspended. What chat
buys you is that other players and server staff treat the account as a person.

### Your Minecraft server can suspend you too

This bot connects to **Aternos**. Aternos' rules do not allow AFK bots or
auto-reconnect clients, and they can suspend the *Aternos server* independently
of any hosting provider. That risk exists on every host. If the server is yours,
run Paper locally or on a VPS and allow it there; if it is someone else's, ask
first.

### How to appeal, without making it worse

1. **Do not create a new account.** Both SillyDev and most panels terminate the
   replacement account for ban evasion — that is how people lose three accounts in
   a week (Render, earlier in this file, is the same story).
2. Ask in their Discord (`discord.gg/Ec4csXrps8`) — SillyDev says support happens
   there, not by email. Ask for the specific policy paragraph.
3. Before asking, fix the three rows above, so the answer is "it is fixed" rather
   than "it was not me".
4. If the bot itself is what they object to, move to a host where a 24/7 client is
   unambiguously the product: a VM (section 3), Termux (section 4), or a paid VPS
   (section 5).

## 12. Lunafy (`panel.lunafy.run`)

Lunafy is a **Discord-bot** host on Pterodactyl. The bot runs fine there; the
dashboard does not, and it is cheaper to know that before uploading.

| | Free server |
| --- | --- |
| RAM / CPU / disk | 256 MB, 0.5 vCPU, 512 MB (their pricing page; some marketing pages say 512 MB — trust what the panel shows) |
| Renewal | every 7 days, one click |
| Card | not needed |
| Open port | **no** — "additional servers and **open ports** are paid" |
| Web servers | **not allowed** by their terms |
| Other | your free server is deleted if it expires; you must stay in their Discord |

### The dashboard cannot be reached on the free plan

No allocation means no `http://IP:PORT` for you. Buying a port from them turns
the dashboard back on (set `DASHBOARD_PASSWORD` first, the port is public), but on
the free plan the URL does not exist and their terms call a web server a
violation — do not try to work around it with a tunnel.

### You can still talk, from the panel console

The dashboard text box and the panel console go to the same function: text
becomes Minecraft chat, `/something` becomes a Minecraft command.

| You type in the **Console** tab | Result |
| --- | --- |
| `hello` | says `hello` in game |
| `/say hi` | says `hi` in game (same thing) |
| `/list` | runs `/list` in game |
| `/status` | connection state and session uptime |
| `/pos` | bot coordinates |
| `/chat off` | stop automatic messages (no restart) |
| `/chat on` | resume them |
| `npm install` | refused: *"npm is a shell command — this box only sends Minecraft chat"* |

That console is the process's stdin. `npm install` and `node doctor.js` typed
there do nothing; dependencies install when the server starts, and to run the
doctor you set `MAIN_FILE=doctor.js` in **Startup** and restart.

### Upload checklist for Lunafy

1. **Startup → Node.js** egg, `MAIN_FILE=index.js`, `NODE_OPTIONS=--max-old-space-size=192`.
2. Upload the ZIP, unzip **into the container root** (no extra folder), `npm ci --omit=dev`.
3. `settings.json` keeps the humanised chat from section 11.
4. No `PORT` needed — with no allocation there is nothing to serve, and the app
   starts either way.
5. Ask in their Discord whether a Minecraft AFK client is welcome. Their whole
   pitch is Discord bots, their terms only rule out web servers, but SillyDev
   suspension stories start with assuming.

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
