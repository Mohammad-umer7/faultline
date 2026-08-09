// Faultline load generator.
//
// A portless, permanently-running service. It is the reason the console is alive
// the instant a judge opens it - there is no empty state and no seeded data,
// because real traffic has been flowing the whole time.
//
// It measures over the PRIVATE network by plain hostname. The spike showed the
// public L7 balancer returns 502 during a repair even while healthy containers
// are serving, so measuring the public path would tell a false story.
const http = require('http');

const TARGETS = [
  { name: 'naive', url: process.env.NAIVE_URL || 'http://naive:3000' },
  { name: 'hardened', url: process.env.HARDENED_URL || 'http://hardened:3000' },
];
const API = process.env.API_URL || 'http://api:3000';
const RPS = Number(process.env.RPS_PER_TARGET || 20);

// keepAlive:false on purpose. A pooled socket pins every request to whichever
// container it first connected to, which makes a 2-container service look like a
// 1-container service and hides the whole effect we are measuring.
const agent = new http.Agent({ keepAlive: false });

function get(base, path) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(base + path, { agent, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({ ok: res.statusCode === 200, ms: Date.now() - started, body })
      );
    });
    req.on('error', () => resolve({ ok: false, ms: Date.now() - started }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - started }); });
  });
}

function report(sample) {
  const payload = JSON.stringify(sample);
  const req = http.request(
    API + '/internal/sample',
    { method: 'POST', timeout: 2000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
    (res) => res.resume()
  );
  req.on('error', () => { /* the api being briefly unreachable must not stop load */ });
  req.on('timeout', () => req.destroy());
  req.end(payload);
}

async function tick() {
  await Promise.all(TARGETS.map(async (t) => {
    const results = await Promise.all(Array.from({ length: RPS }, () => get(t.url, '/work')));
    const ok = results.filter((r) => r.ok);
    const hosts = new Set();
    for (const r of ok) {
      try { hosts.add(JSON.parse(r.body).host); } catch { /* not json */ }
    }
    const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
    const sample = {
      variant: t.name,
      t: Date.now(),
      ok: ok.length,
      err: results.length - ok.length,
      p95: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : 0,
      containers: hosts.size,
    };
    report(sample);
    if (sample.err > 0 || sample.containers !== (t.name === 'hardened' ? 2 : 1)) {
      console.log(`[gen] ${t.name} ok=${sample.ok} err=${sample.err} containers=${sample.containers}`);
    }
  }));
}

console.log(`[gen] ${RPS} req/s per target -> ${TARGETS.map((t) => t.url).join(' ')}, reporting to ${API}`);
setInterval(tick, 1000);
