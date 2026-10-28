# winvm

winvm runs Windows 11 ARM64 virtual machines on an Apple Silicon Mac. You use
it from a Mac app or from the `winvm` command. It uses QEMU with Apple's
Hypervisor.framework.

It exists to reproduce Windows-only bugs on your own Mac, for example in a
[Maximal](https://github.com/stuffbucket/maximal) build, instead of pushing
and waiting on CI. You build a Windows image once, then start disposable
copies of it, run commands in them, and save and restore them in seconds.

## Requirements

- macOS 15 or later on Apple Silicon. Intel Macs are not supported.
- About 15 GB of disk for the Windows image, plus more for each instance.
- A Windows 11 ARM64 ISO. See [Setting up](docs/setup.md#the-windows-iso).

## Install

**The app.** Download `winvm-v<version>-darwin-arm64.dmg` from
[Releases](https://github.com/stuffbucket/winvm/releases) and drag winvm to
Applications. The app includes QEMU. To use `winvm` in a terminal, choose
**winvm → Install Command Line Tool…**, which links `~/.local/bin/winvm` to
the app's copy. **Help → winvm Command Reference** lists the commands.

**From source.** Install [mise](https://mise.jdx.dev), then in this
repository:

```sh
mise install     # Bun and pnpm at the pinned versions
pnpm install
winvm doctor     # checks the host; changes nothing
winvm setup      # downloads the pinned QEMU runtime and the guest tools
```

Inside the repository, mise puts `winvm` on `PATH`. Elsewhere, run
`mise exec -C <repo> -- winvm <command>`.

## First run

```sh
winvm build --iso ~/vm/Win11_25H2_English_Arm64.iso   # once, about 20 minutes
winvm start                                           # about 35 seconds to the desktop
winvm open                                            # see the screen
```

`build` installs Windows unattended into a base image. Every instance is a
copy-on-write overlay on that image. The guest runs as the built-in
Administrator with UAC off, so use it only for testing.

In the app, the Start button does the same as `winvm start`. The image has to
be built from the command line first.

## Common commands

| Command | What it does |
|---|---|
| `winvm start` / `stop` | Start or shut down an instance |
| `winvm status` | Whether it's running, the Windows version, saves, and more |
| `winvm exec -- <cmd>` | Run a command in Windows |
| `winvm put <file> <guest path>` / `get` | Copy a file into or out of Windows |
| `winvm files open [c]` | Show Windows' home folder (or C:\) in Finder |
| `winvm save [name]` / `load [name]` | Save the running machine to disk, and load it back |
| `winvm reset` | Discard all changes and go back to the base image |
| `winvm open` | Show the screen in Screen Sharing (`--web` for the browser) |
| `winvm screenshot`, `click`, `type`, `key` | Drive the screen without a window |
| `winvm diagnose` | Explain why a guest misbehaved |
| `winvm help` | Every command and option |

Most commands take `-i <name>` to pick an instance. The default instance is
`default`. All state lives in `~/.local/state/winvm`, or in `WINVM_HOME` if
you set it.

## More

- [Setting up](docs/setup.md): the ISO, building images, instances, screen
  size, Time Machine, troubleshooting
- [The screen](docs/screen.md): Screen Sharing, the browser view, and driving
  the guest from scripts
- [Saves and goldens](docs/saves.md): saving, loading, and one-second resets
- [Getting files in and out](docs/files.md)
- [CI jobs](docs/jobs.md): `winvm run` and `winvm test`, and
  [running them in parallel](docs/pool.md)
- [Background processes](docs/background.md): the control service and the
  idle watcher
- [Using Windows from Claude Code and Claude Desktop](docs/cua.md#claude-code-and-claude-desktop):
  `winvm mcp install claude-code` (or the app's "Use with Claude" button)
- [The in-guest agent](docs/agent.md), [driving app UI](docs/gui.md),
  [Claude computer use](docs/cua.md)
- [How the VM is configured, and why](docs/windows-vm-qemu.md): read before
  changing `packages/core/src/qemu.ts` or `packages/core/assets/`
- [Releasing](docs/release-runbook.md)

## Development

The repository is a pnpm and Turborepo workspace. The library is
`packages/core`, the command is `apps/cli`, and the Mac app is `apps/viewer`.
`pnpm check` typechecks and tests everything without a VM.

## License

MIT (see `LICENSE`). Third-party notices are in `THIRD-PARTY-LICENSE.md`.
winvm was split out of `stuffbucket/monimal` with `git subtree split`, so its
history is preserved.
