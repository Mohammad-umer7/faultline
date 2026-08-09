// Faultline spike victim.
// Zero dependencies on purpose: no npm install, no build step, fastest path to a
// deployed container. The SAME file runs as both `naive` and `hardened` - the only
// difference between them lives in zerops.yaml.
const http = require('http');
const os = require('os');

const PORT = Number(process.env.PORT || 3000);
const VARIANT = process.env.VARIANT || 'unknown';
const HOST = os.hostname();
const BOOTED = Date.now();

// When poisoned, the process stays alive but every route (including /healthz)
// starts failing. This is the "half-dead process" fault - the one a healthCheck
// catches and a missing healthCheck does not.
let poisoned = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (path === '/healthz') {
    if (poisoned) return send(res, 500, 'poisoned');
    return send(res, 200, 'ok');
  }

  if (path === '/whoami') {
    // The spike's whole question: does traffic from `gen` land on more than one
    // container of `hardened`? This is what answers it.
    return json(res, 200, {
      variant: VARIANT,
      host: HOST,
      pid: process.pid,
      uptimeMs: Date.now() - BOOTED,
    });
  }

  if (path === '/work') {
    if (poisoned) return send(res, 500, 'poisoned');
    return json(res, 200, { host: HOST, t: Date.now() });
  }

  if (path === '/internal/kill') {
    send(res, 200, 'dying');
    // Flush the response before the process disappears, otherwise gen records a
    // socket error instead of the 200 and the timing is off by a request.
    return setTimeout(() => process.exit(1), 50);
  }

  if (path === '/internal/poison') {
    poisoned = true;
    return send(res, 200, 'poisoned');
  }

  if (path === '/internal/cure') {
    poisoned = false;
    return send(res, 200, 'cured');
  }

  send(res, 404, 'not found');
});

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(body);
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// 0.0.0.0, never 127.0.0.1 - binding to loopback is the classic Zerops
// readiness-check failure that costs an hour to diagnose.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[victim] variant=${VARIANT} host=${HOST} pid=${process.pid} listening on 0.0.0.0:${PORT}`);
});
