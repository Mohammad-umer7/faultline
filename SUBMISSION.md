# Submission pack — everything you need to file

## The links

| Field | Value |
|---|---|
| **Project title** | Faultline |
| **Live deployment** | https://console-2db9-3000.prg1.zerops.app |
| **Repository** | https://github.com/Mohammad-umer7/faultline |
| **Demo video** | *you record this — script below* |

---

## Project description (paste into the form)

> Faultline is a public chaos-engineering console with no login. It runs two byte-identical Node services inside one Zerops project — `naive` with one container and no health check, and `hardened` with the same binary plus `healthCheck` and `readinessCheck` — while a load generator hammers both over the private network at 20 requests/second, continuously. Press a red button and the same fault is injected into both services at the same instant. Ninety seconds later you get a verdict card with the measured numbers and the exact `zerops.yml` block that made the difference.
>
> A real measured run: `naive` served **1,760 failed requests and was down for all 88 seconds of the window**, and was still broken when it closed — nothing was watching it, so nothing fixed it. `hardened` was down for **39 seconds and then recovered by itself**: its health check fired and Zerops replaced the failing container. Same code. Six lines of config.
>
> Every run is stored and shown, including the ones where the gap was smaller. The claim is not "hardened never fails" — it is that **naive never comes back on its own and hardened does.**
>
> The point is not that things break. It is that Zerops can only rescue a service that told it how to check.

---

## "How is Zerops used?" (paste into the form)

> Faultline does not merely run on Zerops — Zerops is the thing being measured. It is one project containing seven services: a `console` and an `api` (both `nodejs@22`), a **portless** `nodejs@22` load generator, two byte-identical `nodejs@22` victim services, `postgresql:single@16`, and `valkey@7.2` — the whole topology declared in one `zerops-project-import.yaml` and built from one `zerops.yml` with five `setup:` blocks.
>
> The entire product is an A/B experiment between two Zerops configurations. `naive` has no `deploy.readinessCheck` and no `run.healthCheck`; `hardened` has both. The binaries are identical — the difference is six lines of YAML. When a judge injects a fault, the API fans it out to every container of both services simultaneously, and the load generator — which reaches them over the private network by plain hostname (`http://naive:3000`, `db:5432`, no TLS, no service discovery, **no credentials anywhere in the repository**) — measures the real consequence. The verdict card outputs the exact `zerops.yml` block that produced the difference, and every completed run is persisted to the managed PostgreSQL service over that same private network.
>
> Zerops features on the critical path: `run.healthCheck` (`failureTimeout`, `disconnectTimeout`), `deploy.readinessCheck` (`retryPeriod`), `minContainers`/`maxContainers`, portless long-running services, private-network hostname routing, cross-service env references (`${db_connectionString}`), per-service public subdomains with automatic TLS, and `zcli project project-import` to stand the whole topology up in one command.
>
> This project cannot be ported. On a serverless platform there are no containers to kill, no `minContainers` to differ, no health check to omit — and therefore nothing to measure.

---

## If a judge asks "why didn't you use ZCP?"

> I used the other supported path — `zerops.yml` plus `zerops-project-import.yaml` and `zcli`, written by hand and version-controlled. The whole topology stands up from one file with one command, which is what let me tear `hardened` down and rebuild it three times while debugging the scaling behaviour. That is infrastructure-as-code rather than agent-driven provisioning, and it is the path Zerops documents alongside ZCP.

Do not claim ZCP. It is not in the repo and a judge would find that in ten seconds.

## AI disclosure (paste into the form — the rules require this)

> Built with Claude Code (Claude Opus 5) as a pair. The agent wrote most of the application code and the Zerops configuration.
>
> What I directed rather than delegated: choosing to build a chaos lab instead of another dashboard; insisting the two riskiest platform unknowns were spiked before any product code existed (does the private balancer spread traffic across containers, and how fast does Zerops restart a killed process); swapping the headline fault from "kill a container" to "half-dead process" once measurement showed a container restart takes about one second and makes no visible demo; and rejecting the first `hardened: 0 failed` verdict as an artifact — the single injection request had landed on a container serving no traffic, so the fault now fans out to every container.
>
> Every number in the README and on the live console came off the deployed system and is reproducible by pressing the button.

---

## Demo video — 60-second script

Screencast only. No title card, no face, no intro. Product on screen at 0:00.
**Rehearse the whole run twice before you hit record**, because the fault has a 20-second cooldown.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:05 | The console, already live. Both panels green, latency lines moving. | "These are two identical Node services on Zerops. Same code, same build, deployed twice." |
| 0:05–0:10 | Cut to `zerops.yml` — the `naive` and `hardened` blocks side by side, the healthCheck lines highlighted. | "The only difference is six lines of Zerops config. One has a health check. One doesn't." |
| 0:10–0:14 | Back to console. Press **HALF-DEAD PROCESS**. | "So let's break both of them the same way — a process that's still alive, but answering every request with a 500." |
| 0:14–0:30 | **Both panels go red.** Read the narration bar out loud — it updates live. | "Both are broken now. Watch the difference: the right one is being checked. The left one isn't being watched by anything." |
| 0:30–0:42 | **Right panel turns green again** while the left stays red. Verdict card appears. | "There it goes — the health check fired and Zerops replaced the container. The left one is still broken, and it will stay broken until a human notices. That's the whole difference, and it's five lines of YAML." |
| 0:42–0:52 | Cut to the **Zerops dashboard**, project view, all seven services running. Hover the `hardened` runtime log showing the restart. | "Seven services on one Zerops project — two victims, a portless load generator hitting them over the private network, Postgres, Valkey, an API and the console." |
| 0:52–1:00 | Back to console, scroll to RECENT RUNS. Live URL on screen. | "Every number is measured, every run is stored. No login — break it yourself, link's below." |

**Upload UNLISTED, not private.** Test the link in a logged-out browser before submitting.

---

## Social post (X) — main post, native video, no links

> Two identical Node services. Same code. Same build.
>
> One has a `healthCheck` in its zerops.yml. One doesn't.
>
> I built **Faultline** for @WeMakeDevs × @zeropsio — a public chaos lab where you press a red button, break both the same way, and watch six lines of config decide whether anything survives.
>
> Measured, not mocked:
> naive → 1,780 failed requests, 89s down, still broken
> hardened → 60 failed, 2s down, recovered by itself
>
> No login. Break it yourself. 🧵

**Reply 1:** `Live, no signup: https://console-2db9-3000.prg1.zerops.app`

**Reply 2:** `Source, MIT: https://github.com/Mohammad-umer7/faultline — both zerops.yml blocks are in the README so you can diff naive vs hardened yourself.`

**Reply 3:** *(screenshot of the Zerops project topology)* `7 services on one @zeropsio project: console, api, a portless load generator running 20 req/s over the private network, two victims, Postgres, Valkey. One import YAML, one command.`

**Reply 4:** `The thing I didn't expect: killing a container is nearly invisible — Zerops restarts a dead process in ~1 second. Great engineering, terrible demo. So the headline fault became the half-dead process: alive, broken, and completely unnoticed unless you configured a health check.`

**Reply 5:** `Also: the docs example says failureTimeout: 60. The API rejects bare ints — it wants 60s. Cost me a deploy cycle to find. @zeropsio worth a fix 🙂`

Post at 9–11am or 1–3pm IST and stay on replies for the first hour — early engagement drives most of the reach, and reach is explicitly scored.

---

## Before you submit — 5-minute checklist

1. [ ] Open the live URL **in incognito on your phone**. Charts moving? Press a button — does it work?
2. [ ] Open the GitHub repo **logged out**. Is it public and readable?
3. [ ] Demo video link opens in a logged-out browser.
4. [ ] Revoke the old Zerops token if you haven't (Settings → Token management).
5. [ ] Optional, 30 seconds, worth it: in the Zerops GUI open the **`hardened` service → Scaling → set minimum containers to 2**. If it takes, the `hardened` panel shows two container tiles and one visibly disappears during a fault — much stronger on video. If it doesn't take, nothing breaks and the demo still works.
