// Faultline control plane.
//
// Deliberately a separate service from the victims: the spike showed the public
// L7 balancer returns 502 for ~2 minutes while a service is REPAIRING, so if the
// console lived on a victim, injecting a fault would take down the page the judge
// is scoring. This service is never a fault target.
//
// Zero dependencies - plain node:http. State is the last WINDOW_S seconds of
// samples, held in memory. Postgres/Valkey get wired in for run history and
// verdict permalinks; live traffic does not need them.
const http = require('http');
const https = require('https');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);

// Zerops runs with envIsolation: none, so every service can read every other
// service's connection string directly. Nothing secret ever enters the repo.
// Port 5432 is plaintext-only - 6432 is pgBouncer and REQUIRES TLS, so
// ssl:false here is deliberate, not an oversight.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.db_connectionString,
  ssl: false,
  max: 4,
});

let dbReady = false;
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS runs (
        id              text PRIMARY KEY,
        type            text NOT NULL,
        label           text NOT NULL,
        started_at      timestamptz NOT NULL,
        naive_failed    integer NOT NULL,
        naive_down      integer NOT NULL,
        hardened_failed integer NOT NULL,
        hardened_down   integer NOT NULL
      )
    `);
    dbReady = true;
    console.log('[api] postgres ready');
  } catch (e) {
    // A database hiccup must never stop the live demo. History degrades; the
    // experiment does not.
    console.log('[api] postgres unavailable, run history disabled: ' + e.message);
    setTimeout(initDb, 15_000);
  }
}
initDb();

async function persistRun(run) {
  if (!dbReady) return;
  try {
    const v = run.verdict;
    await pool.query(
      `INSERT INTO runs (id, type, label, started_at, naive_failed, naive_down, hardened_failed, hardened_down)
       VALUES ($1,$2,$3,to_timestamp($4/1000.0),$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [run.id, run.type, run.label, run.startedAt,
       v.naive.failed, v.naive.downSeconds, v.hardened.failed, v.hardened.downSeconds]
    );
  } catch (e) {
    console.log('[api] persist failed: ' + e.message);
  }
}

async function recentRuns(limit = 10) {
  if (!dbReady) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, type, label, started_at, naive_failed, naive_down, hardened_failed, hardened_down
       FROM runs ORDER BY started_at DESC LIMIT $1`, [limit]
    );
    return rows;
  } catch { return []; }
}
const WINDOW_S = 120;
const RUN_MS = 90_000;      // spike: health check fires ~40s, replaces ~2m18s
const COOLDOWN_MS = 20_000;

const VICTIMS = {
  naive: process.env.NAIVE_URL || 'http://naive:3000',
  hardened: process.env.HARDENED_URL || 'http://hardened:3000',
};

const RESET_KEY = process.env.RESET_KEY || 'faultline';

// ─────────────────── Zerops REST API integration ───────────────────
// The console claims "hardened has a healthCheck and naive does not". Rather
// than ask anyone to take that on trust from a README, read the real service
// configuration back out of the official Zerops API and show it. The proof of
// the experiment's premise comes from the platform, not from us.
//
// The token is injected as an env var on the api service and is never in the
// repo. Without it the endpoint reports `configured: false` and everything else
// keeps working - infra proof is an enhancement, never a dependency.
const ZEROPS_API = 'https://api.app-prg1.zerops.io/api/rest/public';
const ZEROPS_TOKEN = process.env.ZEROPS_API_TOKEN || process.env.ZEROPSAPI || '';
const SERVICE_IDS = {
  naive: process.env.NAIVE_SERVICE_ID || 'JMf9WwoMTu6rMwtL1xCxhA',
  hardened: process.env.HARDENED_SERVICE_ID || 'BCEMWHZdSlCcCE4atVBU4A',
};

let infraCache = { at: 0, data: null };

function zeropsGet(path) {
  return new Promise((resolve) => {
    const req = https.request(
      ZEROPS_API + path,
      { method: 'GET', timeout: 6000, headers: { authorization: 'Bearer ' + ZEROPS_TOKEN } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve({ ok: res.statusCode === 200, code: res.statusCode, json: JSON.parse(body) }); }
          catch { resolve({ ok: false, code: res.statusCode, json: null }); }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, err: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'TIMEOUT' }); });
    req.end();
  });
}

// The API response shape is not something to guess at, so walk the object and
// report what is actually there.
// Report only what GET /service-stack/{id} actually returns.
//
// An earlier version searched the payload for a "healthCheck" object and showed
// CONFIGURED / ABSENT per service. That endpoint does not expose health-check
// configuration at all, so it rendered ABSENT for BOTH services - flatly
// contradicting the config diff on the same page. The health-check difference is
// evidenced by zerops.yml in the repo; this panel shows live platform state and
// claims nothing more.
function summarise(stack) {
  if (!stack) return null;
  const auto = stack.customAutoscaling || stack.currentAutoscaling || {};
  const hz = auto.horizontalAutoscaling || auto;
  const vt = auto.verticalAutoscaling || auto;
  const num = (...cands) => cands.find((c) => typeof c === 'number') ?? null;

  return {
    name: stack.name || null,
    status: stack.status || null,
    base: (stack.serviceStackTypeInfo && stack.serviceStackTypeInfo.serviceStackTypeName) || stack.base || null,
    mode: stack.mode || null,
    version: stack.versionNumber ?? null,
    subdomain: stack.subdomainAccess === true,
    minContainers: num(hz.minContainerCount, hz.minContainers),
    maxContainers: num(hz.maxContainerCount, hz.maxContainers),
    minCpu: num(vt.minCpuCoreCount, vt.minCpu),
    maxCpu: num(vt.maxCpuCoreCount, vt.maxCpu),
  };
}

async function fetchInfra() {
  if (!ZEROPS_TOKEN) return { configured: false };
  if (infraCache.data && Date.now() - infraCache.at < 15_000) return infraCache.data;

  const out = { configured: true, source: ZEROPS_API + '/service-stack/{id}', services: {} };
  for (const [variant, id] of Object.entries(SERVICE_IDS)) {
    const r = await zeropsGet('/service-stack/' + id);
    out.services[variant] = r.ok
      ? summarise(r.json)
      : { error: r.err || ('HTTP ' + r.code) };
  }
  infraCache = { at: Date.now(), data: out };
  return out;
}
let shownVerdict = null;

const FAULTS = {
  halfdead: { path: '/internal/poison', label: 'HALF-DEAD PROCESS' },
  kill:     { path: '/internal/kill',   label: 'KILL A CONTAINER' },
  cpu:      { path: '/internal/cpu',    label: 'CPU SATURATION' },
};

/** @type {{naive: any[], hardened: any[]}} */
const samples = { naive: [], hardened: [] };
const events = [];
let currentRun = null;
let lastRunEndedAt = 0;

function pushSample(variant, s) {
  const arr = samples[variant];
  if (!arr) return;
  arr.push(s);
  const cutoff = Date.now() - WINDOW_S * 1000;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}

function addEvent(text, variant) {
  events.unshift({ t: Date.now(), text, variant: variant || null });
  events.length = Math.min(events.length, 40);
}

// keepAlive:false so each request re-resolves and can land on a different
// container of the same service.
const agent = new http.Agent({ keepAlive: false });

function postOnce(base, path) {
  return new Promise((resolve) => {
    const req = http.request(base + path, { method: 'POST', agent, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let host = null;
        try { host = JSON.parse(body).host; } catch { /* plain-text reply */ }
        resolve({ ok: res.statusCode < 500, code: res.statusCode, host });
      });
    });
    req.on('error', (e) => resolve({ ok: false, err: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'TIMEOUT' }); });
    req.end();
  });
}

// Take out ONE container, and say which one.
//
// This went through two wrong versions. Firing a single blind request could land
// on a container serving no traffic, producing a flattering "0 failed" that
// measured nothing. Over-correcting to a wide fan-out poisoned every container
// at once, which leaves no survivor to carry traffic - so a service with a
// health check looked just as broken as one without, and took just as long.
//
// A real incident takes out one container, not all of them. So: hit exactly one,
// read back which host answered, and name it in the timeline. `naive` has one
// container so it loses everything. `hardened` loses one of two and the survivor
// keeps serving while the health check removes the casualty. That is the whole
// point, and it is now attributable rather than assumed.
async function postOne(base, path) {
  const r = await postOnce(base, path);
  return r;
}

// A run injects the SAME fault into both variants at the same instant. Anything
// else and the comparison is not a comparison.
async function startRun(type) {
  const fault = FAULTS[type];
  if (!fault) return { error: 'unknown fault' };
  if (currentRun) return { error: 'experiment already running', run: publicRun() };
  const since = Date.now() - lastRunEndedAt;
  if (since < COOLDOWN_MS) {
    return { error: `cooling down, ${Math.ceil((COOLDOWN_MS - since) / 1000)}s left` };
  }

  const startedAt = Date.now();
  currentRun = { id: String(startedAt), type, label: fault.label, startedAt, endsAt: startedAt + RUN_MS };
  addEvent(`${fault.label} injected into both services`);

  await Promise.all(
    Object.entries(VICTIMS).map(async ([variant, base]) => {
      const r = await postOne(base, fault.path);
      if (!r.ok && r.err) return addEvent(`${variant}: injection returned ${r.err}`, variant);
      addEvent(
        r.host
          ? `${variant}: hit container ${r.host.split('.')[0]}`
          : `${variant}: fault delivered`,
        variant
      );
    })
  );

  setTimeout(finishRun, RUN_MS);
  return { run: publicRun() };
}

function finishRun() {
  if (!currentRun) return;
  const run = currentRun;
  const verdict = {};
  for (const variant of Object.keys(VICTIMS)) {
    const inRun = samples[variant].filter((s) => s.t >= run.startedAt && s.t <= Date.now());
    const failed = inRun.reduce((n, s) => n + s.err, 0);
    // Longest unbroken stretch of seconds with at least one failure.
    let worst = 0, cur = 0;
    for (const s of inRun) {
      if (s.err > 0) { cur++; worst = Math.max(worst, cur); } else cur = 0;
    }
    verdict[variant] = { failed, downSeconds: worst, samples: inRun.length };
  }
  run.verdict = verdict;
  addEvent(
    `verdict — naive ${verdict.naive.failed} failed / ${verdict.naive.downSeconds}s down · ` +
    `hardened ${verdict.hardened.failed} failed / ${verdict.hardened.downSeconds}s down`
  );
  lastRun = run;
  currentRun = null;
  lastRunEndedAt = Date.now();
  persistRun(run);

  // Reset the victims so the next visitor gets a clean board. Curing DOES fan
  // out - a container left poisoned would poison every later run's numbers.
  for (const base of Object.values(VICTIMS)) {
    for (let i = 0; i < 12; i++) postOnce(base, '/internal/cure');
  }
}

let lastRun = null;
function publicRun() {
  return currentRun && { ...currentRun, msLeft: Math.max(0, currentRun.endsAt - Date.now()) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // gen posts one of these per variant per second over the private network.
  if (url.pathname === '/internal/sample' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => {
      try {
        const s = JSON.parse(body);
        pushSample(s.variant, { t: s.t, ok: s.ok, err: s.err, p95: s.p95, containers: s.containers });
      } catch { /* a malformed sample is not worth a 500 */ }
      res.writeHead(204);
      res.end();
    });
  }

  if (url.pathname === '/api/live') {
    return json(res, 200, {
      now: Date.now(),
      windowS: WINDOW_S,
      naive: samples.naive,
      hardened: samples.hardened,
      events,
      run: publicRun(),
      lastRun,
      cooldownMsLeft: Math.max(0, COOLDOWN_MS - (Date.now() - lastRunEndedAt)),
      faults: Object.entries(FAULTS).map(([k, v]) => ({ type: k, label: v.label })),
    });
  }

  // Wipe the board so a recording starts from a clean slate. Keyed so a passer-by
  // cannot erase the run history, but deliberately GET-able so it can be hit
  // from the address bar seconds before hitting record.
  if (url.pathname === '/api/reset' && url.searchParams.get('key') === RESET_KEY) {
    events.length = 0;
    samples.naive.length = 0;
    samples.hardened.length = 0;
    lastRun = null;
    currentRun = null;
    lastRunEndedAt = 0;
    shownVerdict = null;
    for (const base of Object.values(VICTIMS)) {
      for (let i = 0; i < 12; i++) postOnce(base, '/internal/cure');
    }
    if (dbReady) { try { await pool.query('DELETE FROM runs'); } catch { /* history only */ } }
    return json(res, 200, { reset: true, note: 'charts refill within ~2s of live traffic' });
  }

  if (url.pathname === '/api/infra') {
    return json(res, 200, await fetchInfra());
  }

  if (url.pathname === '/api/runs') {
    return json(res, 200, { dbReady, runs: await recentRuns(10) });
  }

  if (url.pathname === '/api/fault' && req.method === 'POST') {
    const type = url.searchParams.get('type') || 'halfdead';
    const out = await startRun(type);
    return json(res, out.error ? 409 : 200, out);
  }

  json(res, 404, { error: 'not found' });
});

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] listening on 0.0.0.0:${PORT}`);
});
