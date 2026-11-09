---
name: winvm-mise
description: Discover and use winvm's repository-local mise tasks for development setup, launching, builds, tests, typechecks, host diagnostics, and explicit visual checks. Select the requested operation, respect its side effects, verify the result, and report failures. Not for publishing or release recovery; use winvm-release.
---

# winvm mise

Mise tasks are the executable interface; this skill supplies selection, safety, and verification. Do not maintain a second task implementation or command catalogue here.

## Discover before executing

1. Identify this checkout and inspect its status. Preserve unrelated changes; do not stash, commit, or push without a request.
2. From the repository root, run `mise tasks ls --local`, then `mise tasks info <task>` for the requested operation. Inspect the actual definition and side effects rather than assuming a task name means the same thing everywhere.
3. Read the relevant sections of [Development](../../../docs/development.md) for prerequisites, native artifact paths, CLI usage, advanced checks, and state isolation. `mise.toml` and package scripts own execution; this document owns shared repository details.
4. Choose the narrowest operation that satisfies the user. If no operation was requested, show available tasks and their meanings; do not automatically set up, build, or launch anything.
5. Execute the discovered task as `mise run <task>` from the repository root. For documented advanced operations not exposed as tasks, use the existing public command/script; do not invent another dispatcher.

Mise supplies pinned tools without shell activation. Missing-tool installation can invoke the existing host/runtime hook; even a diagnostic task is not a guarantee that its tool bootstrap has no writes or downloads. Native builds must keep the viewer's scoped Rust environment.

## Operation boundaries and verification

### Setup and diagnostics

Setup installs dependencies and may bootstrap tools/runtime; it does not create a Windows image or start a guest. Inspect diagnostic output and exit status. Do not silently provision Windows or install device/runtime components to resolve a diagnostic failure.

### Run / dev

- Default to the native Mac viewer for an unqualified request to run the app; use the source CLI when explicitly requested.
- Inspect the existing local bundle and whether that exact copy is running. The dev task opens the existing bundle; it does not rebuild or refresh embedded UI.
- If current source requires a fresh build, follow the build boundary below. Without authorization to replace the previous artifact, report the limitation rather than calling stale code current.
- Interact with a representative control in the actual application, preferably read-only. Capture and read a screenshot when verifying appearance. Launch alone, unit tests, internal imports, and fixture renders are not proof of an actual app run.
- For CLI work, use the public source entrypoint documented in Development, check its output/exit status, and include `-i <authorized-name>` on every instance command.
- Report the artifact used and whether it includes current source. Close temporary review windows and stop only processes this operation started; never stop the person's guest services as cleanup.

### Build

- Select native or UI-only artifacts intentionally. A UI bundle does not update an existing `.app`; the pnpm/Turbo workspace build is not native packaging.
- One build per checkout. Inspect Cargo/Tauri/build processes and the exact previous local `.app` before replacement. The native recipe deletes that bundle; confirm replacement/quit when not already authorized, and quit only that exact local copy.
- Never replace `/Applications/winvm.app` implicitly. Never pass a release version locally: `build-app.ts <version>` rewrites `tauri.conf.json`.
- Inspect output and exit status. Respect the recipe's runtime, nested-signing, sidecar, and bundle-version checks; do not bypass failures or present an old artifact as a successful new build.
- Building does not authorize launching, installation, guest operations, tagging, or publishing.

### Test / check

- Use the full quality gate when requested; focused passes do not establish a full pass. The normal gate needs no Windows VM or Rust compilation.
- When freshness is in question, inspect the force task and ensure root script tests are retained as well as workspace checks.
- Report actual errors and checks passed/skipped. Do not fix source, regenerate tracked files, or delete tests to make checking pass without a separate fix request.
- Visual render scripts are explicit Node/Playwright fixture checks. Serialize jobs sharing UI build outputs, inspect images, and distinguish fixture coverage from native/real-guest acceptance. Use a separate output directory for check-only help renders; default help regeneration writes tracked JPEGs.

## Shared safety boundaries

- Never operate `default` or `pi`. Do not create/start/stop/modify a real VM just to make the app runnable. Real-guest scenarios, device tests, and personal clipboard/file access need explicit authorization for their scope.
- Native fixture windows must have unmistakable test labels in both title and visible UI before showing, isolated state, an explanation of fake data, and cleanup afterward. Empty isolated state is not fake machine data; identify it clearly rather than implying the person's machines disappeared.
- Read the VM/QEMU design document before editing virtual hardware or provisioning; saved-state compatibility must remain intact.
- A denied action is a stop. Do not retry through another script, tool, or agent.
- Publishing, signing-policy changes, release versions, and release recovery belong to [winvm-release](../winvm-release/SKILL.md).

Finish with the operation and command used, observable result or artifact, verification performed, and any failures, stale-artifact limits, or skipped work. Do not claim running, building, testing, and publishing are interchangeable.
