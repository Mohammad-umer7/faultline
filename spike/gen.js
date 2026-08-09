// Faultline spike load generator.
// Answers the two questions that decide whether the project is viable:
//   Q1: does the private L3 balancer spread requests across hardened's 2 containers?
//   Q2: how many seconds does Zerops take to resurrect a container killed with exit(1)?
const http = require('http');
const dns = require('dns').promises;

const TARGETS = [
  { name: 'naive', url: process.env.NAIVE_URL || 'http://naive:3000' },
  { name: 'hardened', url: process.env.HARDENED_URL || 'http://hardened:3000' },
];
const RPS = Number(process.env.RPS_PER_TARGET || 10);

// keepAlive:false is deliberate. A pooled socket pins every request to the one
// container it first connected to, which would make a multi-container service
// look single-container and give a false negative on Q1.
const agent = new http.Agent({ keepAlive: false });

function once(base, path) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(base + path, { agent, timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({ ok: res.statusCode === 200, code: res.statusCode, ms: Date.now() - started, body })
      );
    });
    req.on('error', (e) => resolve({ ok: false, code: 0, ms: Date.now() - started, err: e.code }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, code: 0, ms: Date.now() - started, err: 'TIMEOUT' });
    });
  });
}

async function tick() {
  for (const t of TARGETS) {
    const results = await Promise.all(
      Array.from({ length: RPS }, () => once(t.url, '/whoami'))
    );

    const ok = results.filter((r) => r.ok);
    const err = results.filter((r) => !r.ok);
    const hosts = new Set();
    for (const r of ok) {
      try { hosts.add(JSON.parse(r.body).host); } catch { /* body wasn't json */ }
    }
    const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : -1;
    const codes = [...new Set(err.map((r) => r.err || r.code))].join(',');

    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${t.name.padEnd(8)} ` +
      `ok=${String(ok.length).padStart(2)} err=${String(err.length).padStart(2)} ` +
      `p95=${String(p95).padStart(4)}ms containers=${hosts.size} ` +
      `hosts=[${[...hosts].join(' ')}]${codes ? ' errs=' + codes : ''}`
    );
  }
}

// Independent of the HTTP path: ask DNS directly how many A records the service
// hostname resolves to. If HTTP pins to one container but DNS returns two, the
// fallback is client-side round-robin over these IPs.
async function dnsProbe() {
  for (const t of TARGETS) {
    const host = new URL(t.url).hostname;
    try {
      const addrs = await dns.resolve4(host);
      console.log(`[dns] ${host} -> ${addrs.length} A record(s): ${addrs.join(', ')}`);
    } catch (e) {
      console.log(`[dns] ${host} -> FAILED ${e.code}`);
    }
  }
}

(async () => {
  console.log(`[gen] starting, ${RPS} req/s per target -> ${TARGETS.map((t) => t.url).join(' ')}`);
  await dnsProbe();
  setInterval(dnsProbe, 30000);
  setInterval(tick, 1000);
})();
