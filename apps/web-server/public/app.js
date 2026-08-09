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

// What each fault actually does to the process, in plain English, so a judge
// knows what they are about to cause before they cause it.
const FAULT_SUB = {
  halfdead: 'process stays alive, every request returns 500',
  kill: 'process exits immediately',
  cpu: 'event loop pinned for 60 seconds',
};

function buildControls(faults, disabled, note) {
  if (!controlsBuilt) {
    const box = $('controls');
    box.innerHTML = '';
    for (const f of faults) {
      const b = document.createElement('button');
      b.className = 'fault';
      b.id = 'btn-' + f.type;
      b.innerHTML = escapeHtml(f.label) +
        '<span class="sub2">' + escapeHtml(FAULT_SUB[f.type] || '') + '</span>';
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

    drawChart($('chart-' + v), series, d.now, d.windowS, COLORS[v]);

    const failedNow = running
      ? series.filter((s) => s.t >= d.run.startedAt).reduce((n, s) => n + s.err, 0)
      : series.reduce((n, s) => n + s.err, 0);
    // Say WHICH failures are being counted. A rolling 120s total sitting next to
    // a "healthy" badge reads as a contradiction rather than as history.
    const fl = $('flabel-' + v);
    if (fl) fl.textContent = running ? 'FAILED · THIS RUN' : 'FAILED · LAST 120s';

    const fe = $('fail-' + v);
    fe.textContent = failedNow;
    fe.className = 'v' + (failedNow > 0 ? ' bad' : failedNow === 0 && running ? ' good' : '');

    $('p95-' + v).textContent = last ? last.p95 + 'ms' : '—';
    $('c-' + v).textContent = last ? last.containers : '—';

    const tiles = $('tiles-' + v);
    const n = last ? last.containers : 0;
    // Baseline is the high-water mark actually observed in this window, not a
    // hardcoded expectation - otherwise a service running fewer containers than
    // configured shows a permanent phantom "dead container" that never was.
    const baseline = Math.max(1, ...series.map((s) => s.containers));
    tiles.innerHTML = '';
    for (let i = 0; i < Math.max(baseline, n); i++) {
      const t = document.createElement('div');
      const up = i < n;
      t.className = 'tile ' + (up ? 'up' : 'none');
      t.textContent = up ? '●' : '×';
      tiles.appendChild(t);
    }

    $('panel-' + v).classList.toggle('alarm', !!last && last.err > 0);
  }

  narrate(d);

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

// Narrate the experiment while it runs. Every line below is derived from the
// measurements on screen, never from a timer - if the platform behaves
// differently today, the narration says so rather than lying on schedule.
function narrate(d) {
  const box = $('narration');
  const run = d.run;

  // Between runs: describe the resting state, or the result just produced.
  if (!run) {
    const lr = d.lastRun;
    if (!lr || !lr.verdict) {
      box.className = 'narration';
      setPill('naive', 'healthy', '');
      setPill('hardened', 'healthy', '');
      return;
    }
    box.className = 'narration show done';
    $('nfill').style.width = '100%';
    $('nphase').textContent = 'RUN COMPLETE — ' + lr.label;
    $('ncount').textContent = d.cooldownMsLeft > 0
      ? 'buttons unlock in ' + Math.ceil(d.cooldownMsLeft / 1000) + 's'
      : 'ready for another';
    const v = lr.verdict;
    // Report what was measured, including when it does not flatter the thesis.
    // An earlier version hardcoded "hardened recovered on its own" regardless of
    // the numbers, which is exactly the kind of self-congratulating UI this
    // project exists to argue against.
    const nFail = v.naive.failed, hFail = v.hardened.failed;
    const decisive = hFail <= nFail * 0.5;
    const hardenedNowHealthy = !!(d.hardened || []).slice(-3).every((s) => s.err === 0);

    line('nnaive', 'bad',
      `naive dropped ${nFail} requests over ${v.naive.downSeconds}s. ` +
      (v.naive.downSeconds >= 85
        ? 'It never recovered on its own — it was still broken when the window closed and the fault had to be cleared for it.'
        : 'It only came back when the run ended and the fault was cleared.'));

    if (decisive) {
      line('nhardened', 'good',
        `hardened dropped ${hFail} over ${v.hardened.downSeconds}s — ${Math.round((1 - hFail / Math.max(1, nFail)) * 100)}% fewer. ` +
        'Its health check caught the fault and Zerops routed around the failing container.');
      setPill('hardened', 'recovered', 'recovered automatically');
    } else {
      line('nhardened', 'bad',
        `hardened dropped ${hFail} over ${v.hardened.downSeconds}s — no better than naive in this run. ` +
        'Its health check did fire, but with only one container running there was nothing left to serve traffic while the replacement booted. ' +
        'The health check needs minContainers >= 2 to actually save you.');
      setPill('hardened', 'failing', hardenedNowHealthy ? 'recovered · but too slowly' : 'still recovering');
    }
    setPill('naive', 'failing', 'was broken · unwatched');
    return;
  }

  // During a run.
  const elapsed = Math.max(0, Date.now() - run.startedAt);
  const total = elapsed + run.msLeft;
  box.className = 'narration show';
  $('nfill').style.width = Math.min(100, (elapsed / total) * 100) + '%';
  $('nphase').textContent = run.label + ' — INJECTED INTO BOTH';
  $('ncount').textContent = Math.ceil(run.msLeft / 1000) + 's left in this run';

  for (const v of ['naive', 'hardened']) {
    const inRun = (d[v] || []).filter((s) => s.t >= run.startedAt);
    const last = inRun[inRun.length - 1];
    const failing = !!last && last.err > 0;
    const everFailed = inRun.some((s) => s.err > 0);
    const failed = inRun.reduce((n, s) => n + s.err, 0);
    const id = v === 'naive' ? 'nnaive' : 'nhardened';

    if (elapsed < 3000 && !everFailed) {
      line(id, 'wait', `${v}: fault delivered, waiting for it to show up in traffic…`);
      setPill(v, 'healthy', '');
    } else if (failing) {
      line(id, 'bad', v === 'naive'
        ? `naive is failing right now — ${failed} requests dropped so far. Nothing is watching it, so nothing will fix it.`
        : `hardened is failing — ${failed} dropped. Its health check has ${Math.ceil(run.msLeft / 1000)}s to notice.`);
      setPill(v, 'failing', v === 'naive' ? 'broken · unwatched' : 'broken · being checked');
    } else if (everFailed) {
      line(id, 'good', `${v} recovered by itself after ${failed} failed requests — the health check caught it and Zerops swapped the container out.`);
      setPill(v, 'recovered', 'recovered automatically');
    } else {
      line(id, 'wait', `${v}: still serving normally.`);
      setPill(v, 'healthy', '');
    }
  }
}

function line(id, cls, text) {
  const el = $(id);
  el.className = 'nline ' + cls;
  el.textContent = text;
}

function setPill(variant, cls, text) {
  const el = $('state-' + variant);
  if (!el) return;
  el.className = 'pstate ' + (cls === 'healthy' ? '' : cls);
  el.textContent = text || 'healthy · serving normally';
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

// Run history lives in Postgres, so it survives an api restart and outlives the
// 120s in-memory sample window. Polled far less often than the live charts.
async function pollRuns() {
  try {
    const r = await fetch(API + '/api/runs', { cache: 'no-store' });
    const d = await r.json();
    $('dbstate').textContent = d.dbReady ? '· postgres' : '· postgres unavailable';
    if (!d.runs || !d.runs.length) return;
    $('runs').innerHTML = d.runs.map((run) => {
      const when = new Date(run.started_at).toISOString().slice(5, 16).replace('T', ' ');
      return `<div class="ev">
        <span class="t">${when}</span>
        <span>${escapeHtml(run.label)} —
          <b style="color:var(--naive)">naive ${run.naive_failed} failed / ${run.naive_down}s</b> ·
          <b style="color:var(--hard)">hardened ${run.hardened_failed} failed / ${run.hardened_down}s</b>
        </span></div>`;
    }).join('');
  } catch { /* history is a nicety; the live view is the product */ }
}

// Read the two services' real configuration back from the Zerops REST API, so
// the premise of the experiment is verifiable rather than asserted.
async function pollInfra() {
  try {
    const d = await (await fetch(API + '/api/infra', { cache: 'no-store' })).json();
    if (!d.configured) {
      $('infra').innerHTML =
        '<div class="ev empty">Zerops API token not configured on this deployment — ' +
        'the diff above is still the real zerops.yml in the repo.</div>';
      return;
    }
    $('infrasrc').textContent = '· live';
    $('infra').innerHTML = ['naive', 'hardened'].map((v) => {
      const s = d.services[v] || {};
      if (s.error) return card(v, `<div class="irow"><span class="ik">api</span><span class="iv no">${escapeHtml(s.error)}</span></div>`);
      // Only fields this endpoint genuinely returns. The health-check difference
      // is evidenced by the zerops.yml diff above, not claimed here.
      return card(v, [
        row('status', s.status || '—', s.status === 'ACTIVE'),
        row('runtime', s.base || '—'),
        row('mode', s.mode || '—'),
        row('min / max containers', `${s.minContainers ?? '—'} / ${s.maxContainers ?? '—'}`),
        row('cpu cores', `${s.minCpu ?? '—'} → ${s.maxCpu ?? '—'}`),
        row('deployed version', s.version ?? '—'),
      ].join(''));
    }).join('');
  } catch { /* infra proof is an enhancement, never a dependency */ }
}
function card(v, inner) {
  return `<div class="ic ${v === 'naive' ? 'n' : 'h'}"><div class="icn">${v.toUpperCase()}</div>${inner}</div>`;
}
function row(k, val, flag) {
  const cls = flag === true ? ' yes' : flag === false ? ' no' : '';
  return `<div class="irow"><span class="ik">${escapeHtml(k)}</span><span class="iv${cls}">${escapeHtml(String(val))}</span></div>`;
}

// The verdict's deliverable is a config block you can paste into your own
// zerops.yml, so make taking it away a single click.
document.getElementById('copybtn').onclick = async (e) => {
  try {
    await navigator.clipboard.writeText($('vyaml').textContent);
    e.target.textContent = 'COPIED';
    setTimeout(() => (e.target.textContent = 'COPY'), 1600);
  } catch {
    e.target.textContent = 'SELECT IT';
    setTimeout(() => (e.target.textContent = 'COPY'), 1600);
  }
};

poll();
setInterval(poll, 500);
pollRuns();
setInterval(pollRuns, 5000);
pollInfra();
setInterval(pollInfra, 20000);
