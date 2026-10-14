# Site Health

Live health dashboard for:

- theflooringgroup.co.uk
- bekandze.com
- bigfootartseducation.co.uk
- ansar.london

An Angular 21 dashboard plus a tiny zero-dependency Node checker. The checker runs on
the server because browsers can't probe other domains directly (CORS), and it can
inspect things a browser can't, such as DNS and the SSL certificate.

## What gets checked (every 60s)

| Check | Pass | Warn / Fail |
|---|---|---|
| DNS | domain resolves | ENOTFOUND etc. → **down** |
| HTTPS | final response is 2xx (redirects followed) | 4xx/5xx, timeout, TLS error → **down** |
| Response time | under 3s | over 3s → degraded |
| SSL certificate | trusted, 14+ days left | expiring soon → degraded, expired/untrusted → fail |
| Content | real page with a `<title>` | "Error establishing a database connection", WordPress critical error, maintenance mode, suspended account → **down** |
| Redirects | ≤ 2 hops | longer chains → degraded |
| HTTP→HTTPS | `http://` redirects to `https://` | served over plain HTTP → degraded |

Each card shows a response-time sparkline (failures marked red), uptime % and average
for the session, and a timing breakdown (DNS / connect / TLS / wait / download).
Turn on **Alerts** for a desktop notification when a site goes down or recovers; the tab
title also shows 🔴/🟠 when something is wrong.

## Run it

Requires Node 20.19+ (or 22.12+).

```bash
npm install
npm run build      # builds the Angular app into dist/
npm run serve      # checker + dashboard on http://localhost:3000
```

### Development (live reload)

```bash
npm run api        # terminal 1 — checker on :3000
npm start          # terminal 2 — Angular on :4200, proxies /api to :3000
```

## Configuration

Edit `server/sites.json` to add or remove sites. Environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `CHECK_INTERVAL` | 60 | seconds between runs |
| `CHECK_TIMEOUT` | 15000 | ms per request |
| `SLOW_MS` | 3000 | response-time warning threshold |
| `CERT_WARN_DAYS` | 14 | SSL expiry warning threshold |
| `SITES_FILE` | server/sites.json | alternate site list |

To keep it running on a server: `pm2 start server/server.mjs --name site-health`.
History is held in memory (last 120 checks per site) and resets on restart.

## API

- `GET /api/status` — latest result + history for every site (JSON)
- `GET /api/stream` — Server-Sent Events: `snapshot`, `checking`, `site`, `done`
- `POST /api/check` — run all checks now
