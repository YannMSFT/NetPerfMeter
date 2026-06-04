# WiFi Performance Meter

A browser-based WiFi/network performance measurement tool with a lightweight Node.js server and no client app install.

## What it measures

- **Latency / RTT (min/avg/max):** measured from WebSocket ping/pong round trips between the browser and server.
- **Jitter:** calculated as the mean absolute difference between consecutive WebSocket RTT samples.
- **Packet loss:** calculated from WebSocket pings sent versus pongs received within the client timeout window.
- **Download throughput:** measured with parallel streamed downloads of incompressible random data from the server.
- **Upload throughput:** measured with parallel browser uploads of random data to the server.

## Network Quality Score

After a test completes, all five metrics are combined into a single **Network Quality Score from 0–100** with a letter grade, so you can compare networks (or spots in your home) at a glance.

Each metric is first mapped to its own 0–100 sub-score using realistic anchor points, then combined with these weights:

| Metric | Weight |
| --- | --- |
| Download throughput | 30% |
| Latency (avg RTT) | 25% |
| Upload throughput | 20% |
| Packet loss | 15% |
| Jitter | 10% |

The weighted total maps to a grade: **A+ / A** Excellent (≥80), **B** Good (≥70), **C** Fair (≥55), **D** Poor (≥40), **F** Very poor (<40). The score card shows the per-metric sub-scores so you can see what is dragging the rating down.

## Requirements

- Node.js >= 18
- Any modern browser for the client

## Quick start (local/dev)

```sh
npm install
npm start
```

You can also start the server directly:

```sh
node server/server.js
```

Then open this URL from any device on the same WiFi network:

```text
http://<server-ip>:3000
```

## Configuration

The server listens on `0.0.0.0` and uses the `PORT` environment variable. The default port is `3000`.

Example:

```sh
PORT=8080 npm start
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | TCP port the server listens on (binds `0.0.0.0`). |
| `SERVER_LOCATION` | _(auto)_ | Optional human-readable label for this server's location (e.g. `"Paris Office"`). Overrides the auto-detected display name shown to testers. |

## Server location & multi-region deployment

Each server reports where it runs so a tester can clearly see what they are testing against. The client shows a location card with a badge:

- **Local network** — the tester reached the server over a private/LAN path (the client's address is RFC1918, loopback, link-local, or CGNAT).
- **Internet** — the tester reached the server over a public, internet-routable address.
- **Azure** — the server runs in Microsoft Azure; the Azure region (and a representative city/country) is shown.

**LAN vs Internet is decided per request from the address the client connected from** (`req.socket.remoteAddress`), not from the server's own network interfaces. This is deliberate: with IPv6, almost every home device is assigned a globally-routable address, so "the server has a public IP" is not a reliable signal that it is Internet-exposed. The reliable signal for "am I local to this server or reaching it over the Internet?" is how the tester's browser actually connected.

Azure region detection runs once at startup and is cached. All of this is **dependency-free and makes no third-party calls**. The result is exposed via `GET /api/info` as `exposure` (`lan` | `public` | `azure` | `unknown`), `location` (`{ region, displayName, city, country, countryCode, source, zone? }`), and `hostname`. Azure is detected from:

1. **Azure App Service** environment variables (`WEBSITE_SITE_NAME`, `WEBSITE_INSTANCE_ID`, `REGION_NAME`).
2. **Azure IMDS** (`http://169.254.169.254/metadata/instance`, 1s timeout) for VMs/VMSS.

Notes:
- When running behind a reverse proxy, `remoteAddress` is the proxy (often `127.0.0.1`), so clients would appear as `lan`. `X-Forwarded-For` is intentionally not trusted (it is client-spoofable); deploy without a same-host proxy if you need accurate LAN/Internet classification.
- A tester on the same physical LAN who connects via the server's globally-routable IPv6 will be shown as `Internet` — this is inherent ambiguity, since there is no reliable HTTP-layer way to prove physical locality.

To deploy in multiple Azure regions, run the same app in each region (App Service, a VM, or a container). No configuration is required for the region to be detected and displayed. Set `SERVER_LOCATION` if you want a custom label instead of the auto-detected region name:

```sh
SERVER_LOCATION="West Europe — Amsterdam" PORT=3000 npm start
```

### Deploy to Azure App Service

Azure App Service (Linux) runs this app as-is — it is a standard Node.js server with a single dependency. App Service sets the `PORT` environment variable for you, and the server already listens on it (binding `0.0.0.0`), so no code changes are needed. The region badge is detected automatically from App Service's built-in `WEBSITE_SITE_NAME` / `REGION_NAME` variables.

**Option A — Azure CLI (quickest):**

From the repository root, with the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) installed and logged in (`az login`):

```sh
az webapp up \
  --runtime "NODE:20-lts" \
  --sku B1 \
  --name <globally-unique-app-name> \
  --location westeurope \
  --resource-group wifiperf-rg
```

`az webapp up` creates the resource group, plan, and app if they don't exist, then zip-deploys the current directory. Change `--location` to deploy the same app to different regions (e.g. `eastus`, `francecentral`, `australiaeast`); each instance reports its own region.

**Option B — Create the app, then deploy a zip:**

```sh
# 1. Create resource group, Linux plan, and the web app
az group create --name wifiperf-rg --location westeurope
az appservice plan create --name wifiperf-plan --resource-group wifiperf-rg --sku B1 --is-linux
az webapp create --resource-group wifiperf-rg --plan wifiperf-plan \
  --name <globally-unique-app-name> --runtime "NODE:20-lts"

# 2. Build a deployment zip (omit dev files; include node_modules or let Oryx build)
az webapp deploy --resource-group wifiperf-rg --name <globally-unique-app-name> \
  --type zip --src-path ./deploy-package.zip
```

To let App Service install dependencies for you (Oryx build), enable build-on-deploy and exclude `node_modules` from the zip:

```sh
az webapp config appsettings set --resource-group wifiperf-rg \
  --name <globally-unique-app-name> \
  --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

**Startup command:** App Service auto-detects `npm start`. If you ever need to set it explicitly:

```sh
az webapp config set --resource-group wifiperf-rg \
  --name <globally-unique-app-name> \
  --startup-file "node server/server.js"
```

**Optional settings:**

```sh
# Override the displayed location label (otherwise the Azure region is shown automatically)
az webapp config appsettings set --resource-group wifiperf-rg \
  --name <globally-unique-app-name> \
  --settings SERVER_LOCATION="West Europe — Amsterdam"
```

Notes:
- Do **not** set `PORT` yourself on App Service — the platform provides it and overriding it will break routing.
- The app uses WebSockets (`/ws`) for latency/jitter/loss. Enable them once per app: `az webapp config set --resource-group wifiperf-rg --name <app-name> --web-sockets-enabled true`.
- App Service terminates TLS and serves over HTTPS; the client automatically uses `wss://` for the WebSocket when the page is loaded over HTTPS.
- Because testers reach an App Service over the public Internet, the badge shows **Azure** with the detected region. Use [deployment slots](https://learn.microsoft.com/azure/app-service/deploy-staging-slots) or separate apps per region for multi-region testing.

## Cross-platform support

The server runs on Raspberry Pi (ARM Linux), Windows, macOS, and Linux. The browser client works on iOS, Android, Windows, macOS, and Linux browsers. No app install is needed on client devices.

## Language

The client UI is automatically displayed in **French** when the browser's preferred language is French (e.g. `fr`, `fr-FR`, `fr-CA`); otherwise it falls back to **English**. Detection honors the browser's language priority order, so French is only used when it is preferred over English. No manual setting is required.

## Raspberry Pi deployment

The repository includes a systemd unit and install helper for Raspberry Pi / Debian-based Linux.

From the repository root on the Pi:

```sh
sudo bash deploy/install.sh
```

The installer copies the project to `/opt/wifiperf`, runs `npm install --omit=dev`, installs `deploy/wifiperf.service` to `/etc/systemd/system/wifiperf.service`, reloads systemd, and enables/starts the service.

The service runs as user `pi` by default. If your Raspberry Pi or Debian system uses a different account, edit `/etc/systemd/system/wifiperf.service` and change `User=pi`, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl restart wifiperf
```

Check service status:

```sh
systemctl status wifiperf
```

Follow logs:

```sh
journalctl -u wifiperf -f
```

Open from a device on the same WiFi:

```text
http://<pi-ip>:3000
```

## Accuracy / tips

- Results are bounded by the slower of the two links in the path.
- Run the server on a wired Ethernet connection for a cleaner WiFi client baseline.
- Test the client at different distances and positions from the access point.
- Close other heavy network usage while testing.
- For very high-speed links, a single device CPU may become the bottleneck.

## How it works / API

- `GET /api/info` — returns `{ version, serverTime, platform, arch, hostname, exposure, location }`, where `exposure` is `lan` | `public` | `azure` | `unknown` (decided per request from the client's address) and `location` describes the server's region/city (see [Server location](#server-location--multi-region-deployment)).
- `GET /api/ping` — returns `{ t: <serverEpochMs> }` with `Cache-Control: no-store`.
- `GET /api/download?bytes=N` — streams `N` bytes of incompressible `application/octet-stream` random data; capped at 200 MB.
- `POST /api/upload` — discards the uploaded body and returns `{ received: <bytes> }`.
- `WS /ws` — accepts browser ping messages and returns pong messages for RTT, jitter, and packet loss measurements.

## License

Released under the [MIT License](LICENSE).
