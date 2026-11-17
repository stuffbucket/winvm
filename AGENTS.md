# Agent guide

## Skills and executable tasks

Read [winvm-mise](.claude/skills/winvm-mise/SKILL.md) for development setup, running the app or CLI, builds, tests, typechecks, diagnostics, and visual checks. It discovers the repository's mise tasks, selects the requested operation, applies safety rules, and verifies the result; tasks and package scripts own execution.

Read [winvm-release](.claude/skills/winvm-release/SKILL.md) for packaging a release, publishing, signing-policy changes, or release recovery. These operations have separate approval requirements and are not implied by a development task.

Shared recipes, prerequisites, paths, and advanced operations: [Development](docs/development.md). Discover tasks with `mise tasks ls --local` and inspect an operation with `mise tasks info <task>`. The six core tasks are `setup`, `dev`, `build`, `test`, `check`, and `doctor`; specialized tasks use names such as `ui:build` and `ui:watch`.

## Boundaries

- Run means real application interaction; build does not launch/install/publish; check does not automatically fix failures.
- Preserve unrelated work. Never stash it, and do not commit or push without a request.
- One build per checkout. A native build replaces the previous local `.app`; inspect it first and quit only that exact copy when authorized. Never replace `/Applications/winvm.app` implicitly.
- Every instance command needs `-i <authorized-name>`. Never operate the person's `default` or `pi` instances. Real-guest scenarios and device/clipboard tests need explicit authorization.
- Native fixture windows must have unmistakable test labels before showing, isolated state, and cleanup after verification.
- Read [Windows VM/QEMU design](docs/windows-vm-qemu.md) before changing `packages/core/src/qemu.ts` or provisioning assets. Virtual hardware changes affect saved-state compatibility.
- A denied action is a stop, not permission to use another tool or agent.
