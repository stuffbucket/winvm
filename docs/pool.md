# Running jobs in parallel (`--pool`)

`--pool N` runs the same jobs as `winvm test` (or `winvm run`), spread over N
instances named `ci-1` to `ci-N`, so several jobs run at once.

```sh
winvm test jobs/maximal/ --pool 3
winvm test jobs/maximal/ --pool 3 --pool-prefix ci --image win11-arm64-v4 \
    --junit out.xml --json out.json --keep
```

- `--pool N`: the number of instances, 1 to 16.
- `--pool-prefix P`: name the instances `P-1` to `P-N` (default `ci`).
- `--golden`, `--image`, `--artifacts`, `--keep`, `--junit` and `--json`
  work as they do without `--pool`. See [CI jobs](jobs.md).

Every job must start from a golden save. A job with `reset: false` depends on
the job before it, so `--pool` refuses it.

## Choosing N

Each instance uses 4 virtual CPUs and 4 GiB of memory. You can't change this
per pool, because it is part of a save's compatibility hash. winvm warns if N
x 4 is more than the host's CPU cores, or N x 4 GiB is more than half its
memory. For example, an 18-core Mac with 128 GB fits a pool of 4.

A pool cannot finish faster than its longest job plus one reset. Adding
instances past that point gains nothing.

## What happens

- **Jobs are queued longest first.** winvm orders jobs by how long each took
  in the last pool run, stored in `$WINVM_HOME/runs/job-times.json`. Jobs with
  no recorded time go first. Results are still reported in file order, with
  the instance each job ran on (in the summary, the JUnit `instance`
  property, and the JSON `instance` field).
- **Each instance works on its own.** Each instance takes the next job from
  the queue, resets itself to the golden, runs the job, and repeats. While one
  instance resets, the others keep running jobs.
- **The golden is made once.** winvm creates the golden on `ci-1` and copies
  it to the other instances as APFS clones. The copies take about a second
  each and use almost no extra disk. An instance whose virtual hardware
  differs from `ci-1` gets its own golden instead. If `ci-1`'s golden is
  rebuilt, the copies are replaced on the next run.
- **Files are downloaded once.** Every job's files are fetched before any job
  starts.
- **One stuck job doesn't stop the others.** Each job gets its own timeout
  plus 5 minutes (set `WINVM_POOL_GRACE` to change this). After that, winvm
  records the job as an error, stops it, and kills that instance's QEMU. The
  instance's next reset starts fresh from the golden. If a reset fails, winvm
  kills QEMU and tries once more. If that fails too, winvm stops using the
  instance and gives its job to another one.

## The summary

After the per-job table, a pool run prints lines like these:

```
pool of 3 (ci-1, ci-2, ci-3): 29.4 s wall clock, setup excluded; job time 73.8 s summed, resets 8.0 s summed — 2.78x one instance back to back
exposed reset (resetting, no job running): 1.5 s, 5% of the wall clock (1.5 s of it the first round, 0.0 s after)
  ci-1: 1 job(s), busy 29.2 s; ci-2: 2 job(s), busy 29.4 s; ci-3: 3 job(s), busy 23.2 s
```

**Exposed reset** is the time when at least one instance was resetting and
no instance was running a job. It is the reset time the pool did not hide.
The JSON report has the same figures under `pool`.

## Measured results

Measured 2026-10-22 with the 6 jobs in `jobs/maximal/` (Maximal v0.4.47) on
`win11-arm64-v4`, on an M-series Mac with 18 cores and 128 GB. Times run
from the first reset to the end of the last job, without creating the
golden.

| | wall clock | speed-up |
|---|---:|---:|
| no pool (`winvm test`) | 76 s | |
| `--pool 1` | 72-75 s | |
| `--pool 2` | 41-43 s | about 1.75x |
| `--pool 3` | 29-34 s | about 2.2-2.5x |

- At pool 3 the run took as long as its longest job (nsis, about 28 s) plus
  one reset, so a pool of 4 would not have been faster for these jobs.
- Ordering by length mattered at pool 3. With jobs in file order, nsis
  started fourth and the run took 37 s.
- Each extra instance made the jobs themselves about 5% slower, because the
  instances share the host.
- Creating the golden on `ci-1` took 214 s, mostly waiting for Windows to
  settle. Copying it to each other instance took about 1 s.
- To test failure handling, one job paused its own guest, with
  `WINVM_POOL_GRACE=10s`. winvm stopped the job and killed `ci-1`'s QEMU,
  while `ci-2` ran the other jobs, which passed.
