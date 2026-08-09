// Faultline victim.
//
// This exact file runs as BOTH `naive` and `hardened`. Same bytes, same build,
// same start command. Every difference in behaviour you see in the console comes
// from six lines of zerops.yml, not from here. That is the entire argument of the
// project, so resist the urge to branch on VARIANT for anything but a label.
const http = require('http');
const os = require('os');

const PORT = Number(process.env.PORT || 3000);
const VARIANT = process.env.VARIANT || 'unknown';
const HOST = os.hostname();
const BOOTED = Date.now();

// Alive but broken. The process keeps running, so nothing supervises it back to
// health unless a healthCheck was configured to notice.
let poisoned = false;
// Event loop pinned. Requests queue behind a busy loop rather than failing.
let saturateUntil = 0;

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;

  if (saturateUntil > Date.now() && !path.startsWith('/internal/')) {
    const spin = Math.min(400, saturateUntil - Date.now());
    const end = Date.now() + spin;
    while (Date.now() < end) { /* deliberately pinning the event loop */ }
  }

  switch (path) {
    case '/healthz':
      return poisoned ? send(res, 500, 'poisoned') : send(res, 200, 'ok');

    case '/work':
      if (poisoned) return send(res, 500, 'poisoned');
      return json(res, 200, { host: HOST, t: Date.now() });

    case '/whoami':
      return json(res, 200, {
        variant: VARIANT, host: HOST, pid: process.pid,
        uptimeMs: Date.now() - BOOTED, poisoned,
      });

    case '/internal/poison':
      poisoned = true;
      console.log(`[victim] ${HOST} poisoned - still alive, now failing every request`);
      return send(res, 200, 'poisoned');

    case '/internal/cure':
      poisoned = false;
      saturateUntil = 0;
      return send(res, 200, 'cured');

    case '/internal/cpu':
      saturateUntil = Date.now() + 60_000;
      console.log(`[victim] ${HOST} saturating cpu for 60s`);
      return send(res, 200, 'saturating');

    case '/internal/kill':
      send(res, 200, 'dying');
      // Flush before exiting, or the caller records a socket error instead of
      // the acknowledgement and the run's start timestamp is off by a request.
      return setTimeout(() => process.exit(1), 50);

    default:
      return send(res, 404, 'not found');
  }
});

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(body);
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// 0.0.0.0, never 127.0.0.1 - binding to loopback makes the readiness check fail
// forever while the logs look completely healthy.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[victim] variant=${VARIANT} host=${HOST} pid=${process.pid} on 0.0.0.0:${PORT}`);
});
