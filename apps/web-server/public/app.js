// Faultline console.
//
// Polls, deliberately. SSE appears exactly once in the whole Zerops docs set and
// the L7 balancer has a short response-transmission timeout, so betting the demo
// on a long-lived stream would be betting on undocumented behaviour. At 500ms the
// charts look identical and nothing can silently stall.
const API = new URLSearchParams(location.search).get('api')
  || 'https://api-2db9-3000.prg1.zerops.app';

const VARIANTS = ['naive', 'hardened'];
const COLORS = {
  naive: { line: '#ff9f43', bad: '#ff4757' },
  hardened: { line: '#2ed3c6', bad: '#ff4757' },
};

// Static per-fault copy. The numbers get filled in from the measured run; the YAML
// is the actual block that would have prevented what the judge just watched.
const REMEDY = {
  halfdead: `# naive has no healthCheck, so a process that is alive but broken
# stays in rotation until a human notices.
run:
  healthCheck:
    httpGet:
      port: 3000
      path: /healthz
    failureTimeout: 15s
    disconnectTimeout: 10s`,
  kill: `# minContainers: 1 means the only container IS the service.
minContainers: 2
maxContainers: 4`,
  cpu: `# One saturated container should not be the whole service.
minContainers: 2
verticalAutoscaling:
  minCpu: 1
  maxCpu: 4`,
};

const $ = (id) => document.getElementById(id);
let controlsBuilt = false;
let shownVerdictId = null;

async function poll() {
  try {
    const r = await fetch(API + '/api/live', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    render(await r.json());
    $('status').textContent = 'live · measured over the private network';
    $('status').className = 'status live';
  } catch (e) {
    $('status').textContent = 'reconnecting… (' + e.message + ')';
    $('status').className = 'status';
  }
}

function buildControls(faults, disabled, note) {
  if (!controlsBuilt) {
    const box = $('controls');
    box.innerHTML = '';
    for (const f of faults) {
      const b = document.createElement('button');
      b.className = 'fault';
      b.id = 'btn-' + f.type;
      b.textContent = f.label;
      b.onclick = () => inject(f.type);
      box.appendChild(b);
    }
    const s = document.createElement('span');
    s.className = 'status';
    s.id = 'status';
    box.appendChild(s);
    controlsBuilt = true;
  }
  for (const f of faults) {
    const b = $('btn-' + f.type);
    if (b) { b.disabled = disabled; b.title = note || ''; }
  }
}

async function inject(type) {
  try {
    await fetch(API + '/api/fault?type=' + encodeURIComponent(type), { method: 'POST' });
  } catch { /* the next poll will show whether it took */ }
  poll();
}

function render(d) {
  const running = !!d.run;
  const cooling = d.cooldownMsLeft > 0;
  buildControls(
    d.faults,
    running || cooling,
    running ? 'experiment in progress' : cooling ? 'cooling down' : ''
  );

  for (const v of VARIANTS) {
    const series = d[v] || [];
    const last = series[series.length - 1];
    const expected = v === 'hardened' ? 2 : 1;

    drawChart($('chart-' + v), series, d.now, d.windowS, COLORS[v]);

    const failedNow = running
      ? series.filter((s) => s.t >= d.run.startedAt).reduce((n, s) => n + s.err, 0)
      : series.reduce((n, s) => n + s.err, 0);
    const fe = $('fail-' + v);
    fe.textContent = failedNow;
    fe.className = 'v' + (failedNow > 0 ? ' bad' : failedNow === 0 && running ? ' good' : '');

    $('p95-' + v).textContent = last ? last.p95 + 'ms' : '—';
    $('c-' + v).textContent = last ? last.containers : '—';

    const tiles = $('tiles-' + v);
    const n = last ? last.containers : 0;
    tiles.innerHTML = '';
    for (let i = 0; i < Math.max(expected, n); i++) {
      const t = document.createElement('div');
      const up = i < n;
      t.className = 'tile ' + (up ? 'up' : 'none');
      t.textContent = up ? '●' : '×';
      tiles.appendChild(t);
    }

    $('panel-' + v).classList.toggle('alarm', !!last && last.err > 0);
  }

  const ev = $('events');
  if (d.events && d.events.length) {
    ev.innerHTML = d.events.map((e) =>
      `<div class="ev"><span class="t">${new Date(e.t).toISOString().slice(11, 19)}</span><span>${escapeHtml(e.text)}</span></div>`
    ).join('');
  }

  if (d.lastRun && d.lastRun.verdict && d.lastRun.id !== shownVerdictId) {
    shownVerdictId = d.lastRun.id;
    const V = d.lastRun.verdict;
    $('vn').textContent = V.naive.failed + ' failed';
    $('vns').textContent = V.naive.downSeconds + 's of failing seconds · ' + d.lastRun.label;
    $('vh').textContent = V.hardened.failed + ' failed';
    $('vhs').textContent = V.hardened.downSeconds + 's of failing seconds · ' + d.lastRun.label;
    $('vn').className = 'vbig ' + (V.naive.failed > 0 ? 'bad' : 'good');
    $('vh').className = 'vbig ' + (V.hardened.failed > 0 ? 'bad' : 'good');
    $('vyaml').textContent = REMEDY[d.lastRun.type] || '';
    $('verdict').classList.add('show');
  }
}

function drawChart(cv, series, now, windowS, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight || 120;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  g.strokeStyle = 'rgba(28,37,52,.8)';
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round((h / 4) * i) + .5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  if (!series.length) return;

  const t0 = now - windowS * 1000;
  const x = (t) => ((t - t0) / (windowS * 1000)) * w;
  const maxLat = Math.max(60, ...series.map((s) => s.p95));

  // Error seconds as red columns behind the latency line - an outage should read
  // as a solid red band, not a dip you have to squint at.
  g.fillStyle = 'rgba(255,71,87,.55)';
  for (const s of series) {
    if (s.err > 0) {
      const total = s.ok + s.err;
      const frac = total ? s.err / total : 0;
      const bh = Math.max(3, frac * h);
      g.fillRect(x(s.t) - 2, h - bh, 4, bh);
    }
  }

  g.strokeStyle = color.line;
  g.lineWidth = 1.6;
  g.beginPath();
  series.forEach((s, i) => {
    const px = x(s.t), py = h - (s.p95 / maxLat) * (h * .8) - 4;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  });
  g.stroke();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

poll();
setInterval(poll, 500);
