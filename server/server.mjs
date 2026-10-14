// Site Health checker API — zero dependencies, Node 20+.
// Runs checks on a timer, keeps recent history in memory, streams results to
// the Angular dashboard over Server-Sent Events, and serves the built app.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const INTERVAL_S = Number(process.env.CHECK_INTERVAL || 60);
const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT || 15000);
const SLOW_MS = Number(process.env.SLOW_MS || 3000);
const CERT_WARN_DAYS = Number(process.env.CERT_WARN_DAYS || 14);
const HISTORY = 120;
const STATIC_DIR = path.join(__dirname, '..', 'dist', 'site-health', 'browser');
const SITES = JSON.parse(fs.readFileSync(process.env.SITES_FILE || path.join(__dirname, 'sites.json'), 'utf8'));

/** domain -> { latest, history: [{t, ms, status}] } */
const state = new Map(SITES.map((s) => [s.domain, { latest: null, history: [] }]));
const clients = new Set();

// ---------- low-level request with timings ----------
function request(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const t0 = performance.now();
    const timings = {};
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    const req = lib.get(url, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'SiteHealthMonitor/1.0 (+uptime check)', Accept: 'text/html,*/*' },
    }, (res) => {
      timings.ttfb = performance.now() - t0;
      let cert = null;
      if (res.socket?.getPeerCertificate) {
        const c = res.socket.getPeerCertificate();
        if (c && c.valid_to) {
          cert = {
            subject: c.subject?.CN,
            issuer: c.issuer?.O || c.issuer?.CN,
            validTo: new Date(c.valid_to).toISOString(),
            daysLeft: Math.floor((new Date(c.valid_to) - Date.now()) / 86400000),
            authorized: res.socket.authorized,
            authError: res.socket.authorizationError || null,
          };
        }
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => { size += d.length; if (size < 512 * 1024) chunks.push(d); });
      res.on('end', () => {
        timings.total = performance.now() - t0;
        done({
          ok: true, status: res.statusCode, headers: res.headers, cert, size, timings,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', (e) => done({ ok: false, error: e.message, timings }));
    });
    req.on('socket', (s) => {
      s.on('error', (e) => done({ ok: false, error: e.code ? `${e.code}: ${e.message}` : e.message, timings }));
      s.once('lookup', () => (timings.dns = performance.now() - t0));
      s.once('connect', () => (timings.connect = performance.now() - t0));
      s.once('secureConnect', () => (timings.tls = performance.now() - t0));
    });
    req.on('timeout', () => { req.destroy(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)); });
    req.on('error', (e) => done({ ok: false, error: e.code ? `${e.code}: ${e.message}` : e.message, timings }));
  });
}

async function follow(startUrl, max = 6) {
  const chain = [];
  let url = startUrl;
  for (let i = 0; i <= max; i++) {
    const r = await request(url);
    chain.push({ url, status: r.status ?? null, ms: Math.round(r.timings.total ?? 0) });
    if (!r.ok) return { ...r, chain, finalUrl: url };
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(r.headers.location, url).toString();
      continue;
    }
    return { ...r, chain, finalUrl: url };
  }
  return { ok: false, error: 'Too many redirects', chain, finalUrl: url, timings: {} };
}

// ---------- one full health check ----------
async function checkSite(site) {
  const started = Date.now();
  const checks = [];
  const add = (name, pass, detail, level = pass ? 'ok' : 'fail') => checks.push({ name, level, detail });

  // DNS
  let ips = [];
  try {
    const t = performance.now();
    ips = (await dns.lookup(site.domain, { all: true })).map((a) => a.address);
    add('DNS', true, `${ips.join(', ')} (${Math.round(performance.now() - t)} ms)`);
  } catch (e) {
    add('DNS', false, e.code || e.message);
  }

  // HTTPS homepage
  const r = await follow(`https://${site.domain}/`);
  const finalStatus = r.status ?? null;
  const ms = r.ok ? Math.round(r.chain.reduce((a, c) => a + c.ms, 0)) : null;
  if (!r.ok) add('HTTPS', false, r.error);
  else if (finalStatus >= 200 && finalStatus < 300) add('HTTPS', true, `HTTP ${finalStatus}`);
  else add('HTTPS', false, `HTTP ${finalStatus}`);

  if (r.ok) {
    if (ms > SLOW_MS) add('Response time', false, `${ms} ms (slow > ${SLOW_MS} ms)`, 'warn');
    else add('Response time', true, `${ms} ms`);

    if (r.chain.length > 1) add('Redirects', r.chain.length <= 3, `${r.chain.length - 1} hop(s) → ${r.finalUrl}`, r.chain.length <= 3 ? 'ok' : 'warn');

    if (r.cert) {
      const c = r.cert;
      if (!c.authorized) add('SSL certificate', false, c.authError || 'Not trusted');
      else if (c.daysLeft < 0) add('SSL certificate', false, 'Expired');
      else if (c.daysLeft < CERT_WARN_DAYS) add('SSL certificate', false, `Expires in ${c.daysLeft} days`, 'warn');
      else add('SSL certificate', true, `${c.daysLeft} days left · ${c.issuer ?? ''}`);
    }

    // content sanity: a real page, not a host error / maintenance page
    const title = (r.body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim().replace(/\s+/g, ' ');
    const bad = /(error establishing a database connection|briefly unavailable for scheduled maintenance|account suspended|fatal error|500 internal server error|there has been a critical error)/i.exec(r.body);
    if (bad) add('Content', false, `Page contains “${bad[1]}”`);
    else if (r.size < 512) add('Content', false, `Page is suspiciously small (${r.size} bytes)`, 'warn');
    else add('Content', true, title ? `“${title.slice(0, 80)}”` : `${(r.size / 1024).toFixed(0)} KB`);
  }

  // HTTP -> HTTPS redirect
  const h = await request(`http://${site.domain}/`);
  if (h.ok) {
    const loc = h.headers.location || '';
    const redirects = h.status >= 300 && h.status < 400 && loc.startsWith('https');
    add('HTTP→HTTPS', redirects, redirects ? `${h.status} → ${loc}` : `HTTP ${h.status} served without redirect`, redirects ? 'ok' : 'warn');
  }

  const status = checks.some((c) => c.level === 'fail' && ['DNS', 'HTTPS', 'Content'].includes(c.name)) ? 'down'
    : checks.some((c) => c.level !== 'ok') ? 'degraded' : 'up';

  return {
    ...site,
    status,
    httpStatus: finalStatus,
    responseMs: ms,
    timings: r.ok ? Object.fromEntries(Object.entries(r.timings).map(([k, v]) => [k, Math.round(v)])) : null,
    finalUrl: r.finalUrl,
    redirectChain: r.chain,
    cert: r.cert ?? null,
    server: r.headers?.server ?? null,
    pageBytes: r.size ?? null,
    ips,
    checks,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

// ---------- scheduler ----------
let running = false;
async function runAll() {
  if (running) return;
  running = true;
  broadcast('checking', { at: new Date().toISOString() });
  await Promise.all(SITES.map(async (site) => {
    const result = await checkSite(site).catch((e) => ({ ...site, status: 'down', checks: [{ name: 'Checker', level: 'fail', detail: e.message }], checkedAt: new Date().toISOString() }));
    const s = state.get(site.domain);
    s.latest = result;
    s.history.push({ t: result.checkedAt, ms: result.responseMs, status: result.status });
    if (s.history.length > HISTORY) s.history.shift();
    broadcast('site', { ...result, history: s.history });
  }));
  running = false;
  broadcast('done', { at: new Date().toISOString(), nextInSeconds: INTERVAL_S });
}

function snapshot() {
  return {
    intervalSeconds: INTERVAL_S,
    sites: SITES.map((s) => {
      const st = state.get(s.domain);
      return st.latest ? { ...st.latest, history: st.history } : { ...s, status: 'pending', history: [] };
    }),
  };
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- HTTP server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (url.pathname === '/api/check' && req.method === 'POST') {
    runAll();
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end('{"started":true}');
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    if (running) res.write(`event: checking\ndata: {}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // static Angular build (SPA fallback to index.html)
  let file = path.join(STATIC_DIR, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Dashboard not built yet — run `npm run build`, or use `npm start` for dev mode.');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

process.on('uncaughtException', (e) => console.error('[checker] ignored error:', e.message));

server.listen(PORT, () => {
  console.log(`Site Health API on http://localhost:${PORT} — checking ${SITES.length} sites every ${INTERVAL_S}s`);
  runAll();
  setInterval(runAll, INTERVAL_S * 1000);
});
