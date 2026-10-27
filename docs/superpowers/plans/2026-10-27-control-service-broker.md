# winvm control service, part A: the channel broker (plan 2a of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each running instance gets a service process that alone holds QEMU's QMP and qemu-ga sockets and hands them out one client at a time, publishes state changes as an event stream, and lives as long as the instance (across QEMU being replaced by a load), with no change to any call site.

**Architecture:** A socket-level broker. QEMU binds private sockets (`qmp-qemu.sock`, `qga-qemu.sock`); the service listens on the paths every caller already uses (`qmp.sock`, `qga.sock`) and connects upstream. QMP clients are queued FIFO, given the stored greeting, and have `qmp_capabilities` answered locally; a client that leaves with replies still owed holds the queue until they are drained. qemu-ga clients are queued the same way, and the upstream connection is opened only once QMP reports the guest's port open. `qemu.launch` starts the service (idempotent) before QEMU. The service records QMP events to `events.jsonl` and serves them over HTTP (SSE, token, heartbeats).

**Tech Stack:** Bun 1.4.3 (`node:net` Unix sockets, `Bun.serve`), TypeScript, bun:test with fake QMP and qemu-ga servers.

**Spec:** `docs/superpowers/specs/2026-10-27-monorepo-service-viewer-design.md` ("My calls": the control service; "Lessons carried over from maximal"; "Settled after review").

## Plan sequence (revised)

- 2a (this plan): the broker, the service's lifecycle, `events.jsonl` and the event stream (state and warning events).
- 2b: the idle watcher folded into the service; status from the service's last-known state; boot-phase, job-step and computer-use events; save rename and protected kinds; `winvm open --vnc` / `--close`.
- 3: viewer UI (design system, `viewer-ui`, Playwright layout checks); the old `web/` page retires here, when its replacement exists (moved from plan 2 so `open --web` never goes without a UI).
- 4: Tauri app. 5: release.

## Global Constraints

- No call site changes: every existing `qmp.*`, `monitor.*`, `qga.*` caller keeps passing `p.qmp` / `p.qga`.
- Instances launched before this change (QEMU bound directly to `qmp.sock`) keep working unchanged; the service exists only for instances launched by this code.
- One QMP client and one qemu-ga client at a time per instance, in arrival order; per connection, not per command sequence (a 15-minute `exec` is many short connections, so others interleave).
- The service never opens the qemu-ga socket before QMP `query-chardev` reports `frontend-open: true` for `qga0` (qga.ts's dead-client hazard).
- Event stream: `Bun.serve` with `request.signal`, heartbeats every 15 s, a test that a killed subscriber is cleaned up (Bun 1.3 dropped-stream lesson). Token from `crypto.randomBytes`, passed to the service in its environment, never argv; recorded in `<instance>/service.json` mode 0600.
- The service is started detached (own session), with no parent-PID watchdog; nothing but its own exit rule ends it.
- Bun 1.4.3; tests use `WINVM_HOME` temp dirs and fake sockets; no `mock.module`.

## Review Focus

- **A client that times out mid-request** (savevm at 180 s, a 20 s qga call): its late reply must not reach the next client (Task 1 drain test; qemu-ga relies on its own per-call sync, already tested).
- **QEMU replaced during a load** (quit, relaunch with `-incoming`, monitor silent while the stream loads): the service survives, reconnects, and `monitorAnswers`/`loadSave`'s polls see the new QEMU (Task 3 replacement test).
- **A caller started before the service is listening** (launch races): connecting to `qmp.sock` must wait in the queue, not fail with ENOENT (Task 4: launch starts the service and waits for its sockets before spawning QEMU).
- **Two winvm processes at once on one instance** (status polling during `agent install`, the case behind winvm#5): no interleaved bytes, no stale replies (Task 5 live check).
- **An instance started by the old code** keeps working, and `status` says it has no service (Task 4).

---

### Task 1: Fake QMP server and the QMP queue

**Files:**
- Create: `packages/core/src/broker.ts`, `packages/core/tests/fakes/qmp.ts`
- Test: `packages/core/tests/broker.test.ts`

**Interfaces:**
- Produces:
  - `tests/fakes/qmp.ts`: `class FakeQmp { constructor(path: string); listen(): Promise<void>; close(): Promise<void>; handler: (cmd: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown>>; emit(event: Record<string, unknown>): void; connections: number; commands: string[] }` — sends `{"QMP":{"version":…,"capabilities":[]}}` on connect, requires `qmp_capabilities` first (replies `{"return":{}}`), then answers each line with `handler` (null = never answer), single client at a time like QEMU.
  - `broker.ts`: `class QmpChannel { constructor(o: { listen: string; upstream: string; onEvent?: (e: Record<string, unknown>) => void; drainTimeoutMs?: number }); start(): Promise<void>; stop(): Promise<void>; readonly connected: boolean }`. Behaviour: listens on `listen`; keeps one negotiated upstream connection to `upstream`, reconnecting (retry every 200 ms) whenever it drops; queues clients FIFO; for the active client sends the stored greeting line, answers `qmp_capabilities` locally with `{"return":{}}`, forwards every other line upstream and every upstream line back (events also go to `onEvent`); counts requests sent minus non-event replies; on client close with replies owed, discards that many replies (or until `drainTimeoutMs`, default 200_000) before admitting the next client; a queued client waits while upstream is disconnected.

- [ ] **Step 1: Write the failing tests** (`broker.test.ts`, with a temp dir for sockets)

```ts
it("hands clients the greeting and answers qmp_capabilities itself", async () => {
  // FakeQmp at up.sock; QmpChannel listen=qmp.sock upstream=up.sock
  expect(await monitor.qmpCommand(listen, "query-status")).toEqual({ status: "running" })
  expect(await qmp.status(listen)).toBe("running")
  expect(fake.connections).toBe(1)                 // one upstream connection serves both
  expect(fake.commands.filter((c) => c === "qmp_capabilities")).toHaveLength(1)
})

it("admits one client at a time, in order", async () => {
  // handler delays "slow" 300 ms; start A = qmp.execute(listen, "slow"), then B = qmp.status(listen)
  // B resolves after A; fake.commands order is ["qmp_capabilities", "slow", "query-status"]
})

it("does not hand a late reply to the next client", async () => {
  // handler answers "late" after 300 ms; monitor.qmpCommand(listen, "late", undefined, 50) rejects (timeout)
  // then qmp.status(listen) must return "running", not the late reply
})

it("forwards events to the active client and to onEvent", async () => {
  // fake.emit({ event: "STOP" }) while a client is active; onEvent receives it; the client's next reply is still its own
})

it("keeps clients waiting while QEMU is away, and serves them when it is back", async () => {
  // fake.close(); start qmp.status(listen); restart a new FakeQmp on up.sock after 300 ms; status resolves "running"
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/core && bun test tests/broker.test.ts`
Expected: FAIL, `../src/broker` not found.

- [ ] **Step 3: Implement `FakeQmp` and `QmpChannel`** (line-delimited JSON; `qmp_capabilities` detection by `execute`; the drain counter as above).

- [ ] **Step 4: Run them to see them pass**

Run: `cd packages/core && bun test tests/broker.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/broker.ts packages/core/tests/fakes/qmp.ts packages/core/tests/broker.test.ts
git commit -m "feat(service): a QMP channel that serves one client at a time over one upstream connection"
```

---

### Task 2: The qemu-ga queue, gated on the guest's port

**Files:**
- Modify: `packages/core/src/broker.ts`
- Create: `packages/core/tests/fakes/agent.ts` (the `FakeAgent` from `tests/qga.test.ts`, moved so both tests share it)
- Modify: `packages/core/tests/qga.test.ts` (import the moved `FakeAgent`)
- Test: `packages/core/tests/broker.test.ts`

**Interfaces:**
- Consumes: Task 1's `QmpChannel`, `FakeQmp`.
- Produces: `class QgaChannel { constructor(o: { listen: string; upstream: string; portOpen: () => Promise<boolean | null> }); start(); stop() }`. Behaviour: clients queued FIFO; for each admitted client, polls `portOpen` (250 ms) until true, then opens a fresh upstream connection (as qga.call does today) and pipes bytes both ways until the client closes, then closes upstream. The service passes `portOpen = () => qga.portOpen(listenQga)` — i.e. QMP `query-chardev` through its own QMP channel.

- [ ] **Step 1: Write the failing tests**

```ts
it("never connects to the agent before the guest opens its port", async () => {
  // portOpen returns false for 500 ms, then true; start qga.call(listenQga, { execute: "guest-ping" })
  // agent.connections stays 0 until portOpen is true; the call then resolves
})

it("serves qga callers one at a time, each with its own sync", async () => {
  // two concurrent qga.call()s; both resolve with their own replies; agent sees them on separate connections, not interleaved
})

it("lets other callers in between the polls of a long exec", async () => {
  // qga.exec with a fake guest-exec-status that reports running for 1 s; a qga.call started meanwhile resolves before the exec does
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/core && bun test tests/broker.test.ts`
Expected: the 3 new tests FAIL (`QgaChannel` not exported); Task 1's still pass.

- [ ] **Step 3: Move `FakeAgent` to `tests/fakes/agent.ts`, implement `QgaChannel`.**

- [ ] **Step 4: Run them to see them pass, and qga's own tests**

Run: `cd packages/core && bun test tests/broker.test.ts tests/qga.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/broker.ts packages/core/tests
git commit -m "feat(service): a qemu-ga channel that opens the agent only once the guest's port is open"
```

---

### Task 3: The service process, its record and its event stream

**Files:**
- Create: `packages/core/src/service.ts`
- Modify: `packages/core/src/paths.ts` (`Paths.qmpQemu`, `Paths.qgaQemu`, `Paths.service`, `Paths.events`), `apps/cli/src/winvm.ts` (`serve` verb, not listed in usage)
- Test: `packages/core/tests/service.test.ts`

**Interfaces:**
- Consumes: `QmpChannel`, `QgaChannel`.
- Produces:
  - `paths.ts`: `qmpQemu: <dir>/qmp-qemu.sock`, `qgaQemu: <dir>/qga-qemu.sock`, `service: <dir>/service.json`, `events: <dir>/events.jsonl`.
  - `interface ServiceInfo { pid: number; port: number; token: string; cli: string; version: string; startedAt: string }` (`version` is `@winvm/core`'s package.json version, so a CLI can tell a service from another build).
  - `interface WinvmEvent { t: string; instance: string; kind: "state" | "warning" | "service"; [k: string]: unknown }`.
  - `runService(name: string, o?: { exitAfterMs?: number; heartbeatMs?: number }): Promise<void>`: removes stale `p.qmp`/`p.qga` socket files, starts both channels (listen `p.qmp`/`p.qga`, upstream `p.qmpQemu`/`p.qgaQemu`), writes `service.json` (0600) with a token from `process.env["WINVM_SERVICE_TOKEN"]`, appends a `service` event `{ what: "started" }`; maps QMP events to `state` events (`STOP`→`paused`, `RESUME`→`running`, `SHUTDOWN`→`stopped`, `RESET`→`reset`, `MIGRATION` with its status) and appends each to `events.jsonl` and to subscribers; serves `GET /events` (SSE; `?key=` token; replays nothing; heartbeat comment every `heartbeatMs`, default 15_000) and `GET /status` (`X-Winvm-Token`; `{ state, qemuPid, connected }`); exits (removing `service.json` and its sockets, appending `{ what: "stopped" }`) once `qemu.pidOf(p)` has been null for `exitAfterMs` (default 10_000) and `saves/<name>/.lock` is not held by a live pid.
  - `readService(p: Paths): ServiceInfo | null` (null if absent or its pid is dead).
  - CLI `winvm serve -i <name>` runs `runService`.

- [ ] **Step 1: Write the failing tests** (temp `WINVM_HOME`, an instance dir, `FakeQmp` on `qmpQemu`, `FakeAgent` on `qgaQemu`, a fake `qemu.pid` holding the test's own pid)

```ts
it("serves the instance's sockets and records itself", async () => {
  // runService("t", { exitAfterMs: 200 }) in-process; qmp.status(p.qmp) === "running"; readService(p)?.pid === process.pid; mode of service.json is 0o600
})

it("records QMP events as state events, on disk and on the stream", async () => {
  // subscribe to /events?key=token; fake.emit({ event: "STOP", timestamp: … }); the stream yields a state event { state: "paused" }; events.jsonl's last line has the same
})

it("drops a subscriber that went away", async () => {
  // open /events, abort the fetch; after the next heartbeat (heartbeatMs: 50) the service's subscriber count is 0
})

it("refuses the stream without the token", async () => {
  // GET /events without key → 401; /status without header → 401
})

it("survives QEMU being replaced, and stops once QEMU is gone for good", async () => {
  // close the FakeQmp, write a new pid, start a new FakeQmp: qmp.status(p.qmp) works again
  // remove qemu.pid (no lock held): runService resolves within exitAfterMs + margin; service.json and qmp.sock are gone
})

it("waits out a load: QEMU gone but the save lock held by a live pid", async () => {
  // remove qemu.pid but write saves/t/.lock with process.pid; after 2 × exitAfterMs the service is still serving
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/core && bun test tests/service.test.ts`
Expected: FAIL, `../src/service` not found.

- [ ] **Step 3: Implement `service.ts`, the `Paths` fields, and the `serve` verb.** Expose the subscriber count for the test (`runService` returns or accepts a handle; builder's choice, named in the test).

- [ ] **Step 4: Run them to see them pass**

Run: `cd packages/core && bun test tests/service.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/service.ts packages/core/src/paths.ts packages/core/tests/service.test.ts apps/cli/src/winvm.ts
git commit -m "feat(service): a per-instance service that owns QEMU's sockets and streams its state"
```

---

### Task 4: QEMU binds private sockets; launch starts the service first

**Files:**
- Modify: `packages/core/src/qemu.ts` (`qemuArgs`: `-chardev socket,path=${p.qgaQemu}`, `-qmp unix:${p.qmpQemu}`; `launch`: ensure the service before spawning QEMU; `-incoming` removes `p.qmpQemu`, not `p.qmp`), `packages/core/src/service.ts` (`ensureService`), `packages/core/src/status.ts` (a `service` line)
- Test: `packages/core/tests/service.test.ts`, `packages/core/tests/ui.test.ts` (status formatting)

**Interfaces:**
- Consumes: Task 3's `runService`, `readService`, `Paths.qmpQemu`/`qgaQemu`.
- Produces: `ensureService(name: string, p: Paths): Promise<ServiceInfo>` — returns the running service if `readService(p)` is live and its `cli` equals `cliEntry()`; otherwise stops a service from another CLI (SIGTERM, wait) and spawns `cliEntry() serve -i name` detached (`setsid`-equivalent: `detached: true`, own process group), with `WINVM_SERVICE_TOKEN` from `crypto.randomBytes(24).toString("base64url")` in its env, then waits (≤ 10 s) until `p.qmp` and `p.qga` accept connections. `InstanceStatus.service: { pid: number; port: number } | null`, formatted as `service       pid N · 127.0.0.1:PORT` or `service       none (started before the control service)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("starts the service once, and reuses it", async () => {
  // with WINVM_CLI pointing at apps/cli/src/winvm.ts: ensureService twice → same pid; p.qmp and p.qga exist as sockets
})

it("hands QEMU the private sockets", () => {
  // qemuArgs(...) contains `unix:${p.qmpQemu},server=on,wait=off` and `socket,path=${p.qgaQemu},` and neither p.qmp nor p.qga
})

it("says when an instance has no service", () => {
  // statusReport for a running status with service null contains "none (started before the control service)"
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/core && bun test tests/service.test.ts tests/ui.test.ts`
Expected: the 3 new tests FAIL.

- [ ] **Step 3: Implement** `ensureService`, the `qemuArgs` and `launch` changes, and the status line.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm check`
Expected: all pass (207 + the new ones), 4 scripts tests.

- [ ] **Step 5: Boot a guest end to end through the service**

Run: `CAGE_WINVM=$PWD/apps/cli/src/winvm.ts CAGE_ENABLE_WHP=1 ~/github/stuffbucket/cage/checks/windows-arm64-winvm/run.sh` (from the worktree root, so its `apps/cli` runs)
Expected: `0 failed`, including the reboot step.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/tests
git commit -m "feat(service): QEMU binds private sockets and launch starts the instance's service first"
```

---

### Task 5: Two clients at once, live, and the service's lifetime

**Files:**
- Modify: `README.md` (a "Control service" section), `docs/agent.md` if it describes socket access

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: The winvm#5 situation, live** — boot an instance in `~/.local/state/cage-winvm` (`winvm start -i svc-test --ephemeral --no-watch`), then run `winvm status -i svc-test` every second in the background while running `winvm agent install -i svc-test` three times.
Expected: all three installs succeed; `winvm status` never reports the guest agent unreachable while QEMU is running; `events.jsonl` has the `service started` event.

- [ ] **Step 2: The stream, live** — `curl -N "http://127.0.0.1:PORT/events?key=TOKEN"` (from `service.json`) while running `winvm pause -i svc-test` and `winvm resume -i svc-test`.
Expected: `state` events `paused` then `running`.

- [ ] **Step 3: Lifetime** — `winvm stop -i svc-test`.
Expected: within ~10 s of QEMU exiting, the service is gone (`service.json`, `qmp.sock`, `qga.sock` removed; `events.jsonl` ends with `service stopped`). `winvm destroy -i svc-test`.

- [ ] **Step 4: An instance from the old code** — not reproducible without an old QEMU running; covered by Task 4's status test and by `qemuArgs` (old instances keep their direct `qmp.sock`). Record in the PR.

- [ ] **Step 5: Document** the service in `README.md`: what it is, `service.json`, `events.jsonl`, `/events` and `/status`, that it lives as long as the instance, and that QEMU's own sockets are `qmp-qemu.sock` / `qga-qemu.sock` (do not connect to them directly).

- [ ] **Step 6: Commit**

```bash
git add README.md docs
git commit -m "docs: the per-instance control service"
```

## Known gap

QEMU being replaced by a load is tested against fake sockets only (Task 3). A live load needs an image with virtio boot (`win11-arm64-v4`, about 15 GB to build); the cage image has none. Recorded in the PR; worth a live run once a v4 image exists.
