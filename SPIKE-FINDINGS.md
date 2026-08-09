# Spike findings — 2026-08-09, hour 1

Measured on a real Zerops project (`faultline`, LIGHT core package, prg1).
Every number here came off the deployed services, not the docs.

## The concept is viable

**Q1 — Does the private L3 balancer spread traffic across multiple containers
of one service, addressed by plain hostname?**

**Yes.** `gen` hitting `http://hardened:3000` with `keepAlive: false`:

```
naive     ok=10 err=0  containers=1  hosts=[node-id-1.runtime.naive.zerops]
hardened  ok=10 err=0  containers=2  hosts=[node-id-1... node-id-2.runtime.hardened.zerops]
```

Both containers serve. No DNS round-robin fallback needed. Internal latency
4–20ms idle. This was the risk that could have killed the project.

## The headline fault changes: KILL is out, HALF-DEAD is in

**Q2 — How long is the outage when a container is killed with `process.exit(1)`?**

**~1 second.** Killed at 17:35:34; the new process was already up at 17:35:35
(pid 649 → 1125). `gen` recorded exactly one bad second:

```
[13:37:22] naive  ok=0 err=10 containers=0 errs=TIMEOUT
```

One second is a blip, not a demo. The Zerops supervisor restarts a dead process
almost instantly, which is great for users and useless for a 60-second video.

**So the primary fault becomes HALF-DEAD PROCESS**, and it is a far better story:

### naive (no `healthCheck`) — bleeds indefinitely

Poisoned at 17:38:11. Four minutes later:

```
/work     HTTP 500
/healthz  HTTP 500
/whoami   {"pid":1125,"uptimeMs":396865}   <- same pid, never restarted
```

The process is alive, so nothing restarts it. Zerops has no way to know it is
broken, because the service never told it how to check. It served 100% errors
for as long as we left it.

### hardened (`healthCheck` configured) — caught and replaced

Poisoned `node-id-1` at 13:43:10Z:

| Time (UTC) | Event |
|---|---|
| 13:43:10 | one container poisoned |
| 13:43:50 | `✅ exec node spike/victim.js` — health check killed that container (~40s) |
| 13:45:28 | `node-id-3` boots and joins the pool (~2m18s to full replacement) |

**And the private network never saw a single failed request:**

```
[13:46:10] hardened ok=10 err=0 containers=2 hosts=[node-id-2 node-id-3]
```

`node-id-1` silently left, `node-id-3` silently arrived, traffic never noticed.
That is the whole product in one log line.

## Corrections to the original plan

1. **`failureTimeout` / `retryPeriod` / `disconnectTimeout` are Go duration
   strings, not integers.** The docs example shows `failureTimeout: 60`; the API
   rejects it with `cannot unmarshal !!int into time.Duration`. Use `30s`.
2. **`retryPeriod` is clamped to `<10s, 1h>`.** `5s` is rejected.
3. **Health-check reaction is ~40s, full replacement ~2m18s** — not the 15s the
   plan assumed. Run windows must be ~90s, not 45s.
4. **`zcli push` looks for `zerops.yml`, not `zerops.yaml`.** The import file
   keeps the `.yaml` extension; the build file must be `.yml`.
5. **`zcli service log` takes `-S`, not a positional service name.**

## Operational gotchas found

- **The public L7 balancer 502s for ~2 minutes while a service is `REPAIRING`**,
  even though healthy containers exist and the private path is clean. The
  console (`web`, `api`) must therefore be separate services from the victims —
  a judge must never be able to break the page they are scoring. Already planned;
  now it is load-bearing rather than tidy.
- **Private DNS is intermittently unreliable**: `[dns] hardened -> FAILED ENOTFOUND`
  appears every few minutes while HTTP to the same hostname keeps working. Do not
  build container discovery on `dns.resolve4`.
- **`envIsolation` is `none`** on this project, so every service can read every
  other service's `*_connectionString` directly. No secrets need to live in the repo.
- **p95 rose to ~500ms during the repair window** on the LIGHT package under
  10 req/s. Worth watching when the load generator goes to 20 req/s per target.

## Design consequences

- Headline fault: **HALF-DEAD PROCESS**. Secondary: CPU saturation. KILL becomes a
  supporting beat ("Zerops caught this one in a second — that is the point").
- Measurement must come from the **private** network path, not the public URL.
  The public path tells a misleading story during repair.
- Run window: **90 seconds**, so the health check has time to fire on camera.
