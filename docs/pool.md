# `winvm test --pool N`: jobs side by side

```sh
bun winvm.ts test jobs/maximal/ --pool 3 [--pool-prefix ci] [--image win11-arm64-v4] \
    [--junit out.xml] [--json out.json] [--keep]
```

Runs the same jobs as `winvm test`, over N instances `ci-1` … `ci-N` at once.
The mechanics are at the top of `pool.ts`; in short:

- **One worker per instance** pulls the next job off a shared queue, resets its
  own instance to the job's golden, runs the job, and pulls again. A reset
  only blocks its own instance, so it hides behind the other instances' jobs.
- **Longest job first**, by each job's time in the previous pool run
  (`$WINVM_HOME/runs/job-times.json`; never-timed jobs go first). Results are
  still reported in file order, with the instance each job ran on (summary
  column, JUnit `instance` property, JSON `instance`).
- **One golden, cloned.** The golden is created once on `ci-1` (boot, agent,
  settle, mapped-ram save) and copied to the other members with
  `saves.cloneSave`: APFS clones of the RAM file, overlay and NVRAM, so no
  boot, no settling and no extra disk. This is safe because a save's
  compatibility hash excludes everything per-instance (paths, sockets, VNC
  port), the agent's and DevTools' port forwards are added at runtime, and TPM
  state travels in the migration stream. The one thing inside the guest that
  is per-instance is the agent's token, so it is copied into each member's
  `agent.json` (each keeps its own host port). A member whose hardware hash
  differs gets its own golden, created independently in parallel. A clone
  records `clonedFrom`, so rebuilding `ci-1`'s golden re-clones the others.
- **Failure isolation.** A job has its timeout plus 5 minutes
  (`WINVM_POOL_GRACE` overrides) before a watchdog records it as an error,
  cancels its remaining steps, and kills the instance's QEMU; that
  instance's next reset starts a fresh one from the golden. A reset that
  fails is retried once after killing QEMU, and if it fails again the
  instance is retired and the job requeued for another member. The other
  instances carry on regardless.
- **Resources.** Each instance is 4 vCPUs / 4 GiB. That isn't tunable per
  pool, because it's part of a save's compatibility hash. A pool larger than
  the host's cores, or half its memory, is warned about. On an 18-core,
  128 GB host N = 4 fits.
- Every job's files are fetched once, up front, before any job runs.

Jobs with `reset: false` are refused: they depend on the job before them.

## The summary

Besides the per-job table, a pool run reports:

```
pool of 3 (ci-1, ci-2, ci-3): 29.4 s wall clock, setup excluded; job time 73.8 s summed, resets 8.0 s summed — 2.78x one instance back to back
exposed reset (resetting, no job running): 1.5 s, 5% of the wall clock (1.5 s of it the first round, 0.0 s after)
  ci-1: 1 job(s), busy 29.2 s; ci-2: 2 job(s), busy 29.4 s; ci-3: 3 job(s), busy 23.2 s
```

**Exposed reset** is wall-clock time during which some instance was resetting
and no instance was running a job. That's the reset cost the pool did not
hide. The sum of reset times doesn't measure this once jobs overlap. The JSON
carries the same figures under `pool`.

## Measured (2026-10-22)

The setup: the 6 jobs in `jobs/maximal/` (broker, install.ps1, msi, nsis,
settings-ui, zip; Maximal v0.4.47) on `win11-arm64-v4`, on an M-series host
with 18 cores and 128 GB. The wall clock is from the first reset to the last
job finishing. Golden creation is excluded and reported separately below.
Pool runs 1 and 2 had no job times yet, so they queued in file order; the
later runs queued longest first.

| pool | run | wall clock | job time (sum) | resets (sum) | exposed reset | of which after the first round |
|---:|---|---:|---:|---:|---:|---:|
| 1 | a | 74.6 s | 66.6 s | 8.0 s | 8.0 s (10.7%) | 6.8 s |
| 1 | b | 71.9 s | 64.8 s | 7.0 s | 7.0 s (9.7%) | 5.7 s |
| 1 | c | 75.3 s | 68.0 s | 7.2 s | 7.2 s (9.6%) | 5.7 s |
| 2 | a (file order) | 41.4 s | 69.5 s | 8.4 s | 0.9 s (2.3%) | 0.0 s |
| 2 | b | 42.9 s | 70.7 s | 8.7 s | 2.7 s (6.2%) | 1.6 s |
| 2 | d | 42.9 s | 70.8 s | 8.4 s | 3.7 s (8.7%) | 2.3 s |
| 3 | a (file order) | 37.1 s | 73.1 s | 10.3 s | 1.7 s (4.6%) | 0.0 s |
| 3 | b | 29.4 s | 73.8 s | 8.0 s | 1.5 s (5.2%) | 0.0 s |
| 3 | c | 34.2 s | 76.3 s | 12.6 s | 3.1 s (9.0%) | 0.0 s |

`winvm test` without `--pool` on the same jobs took 75.6 s: 67.3 s of job
time and 8.2 s of resets.

- **Speed-up.** Pool 2 runs about 1.75x faster (~43 s vs ~74 s). Pool 3 runs
  about 2.2-2.5x faster (29-34 s). At pool 3 the run is bound by its longest
  job (nsis, ~27-29 s) plus one reset, so a pool of 4 would gain nothing for
  this set.
- **Longest first** matters at pool 3. In file order, nsis started fourth
  and was the whole tail (37.1 s). Queued first, it gave 29-34 s.
- **Exposed reset** falls from ~10% of the wall clock (one instance: every
  reset is exposed) to the first round plus a short tail. When the queue
  drains, one instance may still be resetting for the last job while the
  others are already idle. The first round is ~1-1.5 s, or ~3 s when three
  mapped-ram loads run at once.
- **Contention.** Summed job time grows about 5% per extra instance (66-68 s →
  70-71 s → 73-76 s), and concurrent resets are slower (1.1-2.3 s vs
  0.9-1.6 s).
- **Golden.** Created once on `ci-1`: 214 s, mostly settling. Cloned to each
  other member: about 1 s, including creating the instance. The first clone
  run's whole setup took 11.3 s, with the release lookup included.
- **Failure isolation**, checked with a job that pauses its own guest
  (`shell: winvm` → `pause`), with `WINVM_POOL_GRACE=10s`. The watchdog fired
  at 30 s and killed `ci-1`'s QEMU. `ci-2` meanwhile ran msi and zip, which
  passed. At `--pool 1`, the msi job after the wedged one reset the killed
  instance (1.0 s) and passed.

Two failures in these runs weren't caused by the pool:

- `install-ps1` fails in every run, pooled or not, at "the user PATH gained
  the install dir as its own entry". It needs a fix in the job or in
  Maximal's `install.ps1`.
- `settings-ui` failed once in 10 runs (pool 2, run c). Settings never opened
  ("no page matching /ui/settings": only the splash page was there). That
  job's "open Settings" second launch lands 0.3 s after the sidecar answers,
  which is a race, and load makes it more likely.

Each `ci-N` instance is a 4 GiB guest while it runs. Its golden is a clone of
`ci-1`'s and shares blocks until either side writes, so it costs little
extra disk.
