// Static file server for the Faultline console.
//
// Why not a Zerops `static` service? Because it would not start. With
// `type: static` the container returned 502 on every path and port, with
// completely empty application AND webserver logs, across three configurations
// (documentRoot, routing.root, and os:alpine + base:static per the docs' own
// minimal example). Rather than keep guessing at an undocumented failure with a
// deadline running, the console is served by its own Node service.
//
// The architectural point is unchanged and is the one that matters: the console
// runs on its own container, publicly routed, completely isolated from the
// victim services. A judge can inject faults all day without touching the page
// they are scoring.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // Resolve inside ROOT only - a path like /../../etc/passwd must not escape.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[web] serving ${ROOT} on 0.0.0.0:${PORT}`);
});
