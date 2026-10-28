# Getting files in and out

## `put` and `get`

```sh
winvm put build/maximal-setup.msi 'C:\work\maximal-setup.msi'
winvm get 'C:\work\install.log' install.log
```

These copy one file through the in-guest agent, or through the QEMU guest
agent if the in-guest agent isn't running. The instance has to be running.
Through the in-guest agent, they also copy a folder and everything in it.

To see what's in a guest folder:

```sh
winvm dir                        # the Desktop
winvm dir 'C:\work' --all        # hidden files too
winvm dir --places               # Desktop, Documents, Downloads, the profile, C:\work, drives
```

To change them:

```sh
winvm mkdir 'C:\work\logs'                   # a new folder
winvm mv 'C:\work\a.txt' 'C:\work\b.txt'     # rename; into the folder <to> if it is one
winvm cp 'C:\work\logs' 'C:\work\logs-old'   # a copy in the guest, folders too
winvm rm 'C:\work\b.txt'                     # to the Recycle Bin; --permanently for good
```

None of these replaces anything: a name that's taken is an error. They need
the in-guest agent. With `--json` they print `{"path": …}` (`rm`:
`{"deleted": n}`), or `{"error": …, "code": …}` when they fail.

The winvm app has a file browser for this: the Files button in its toolbar.

## Shared folder

A folder on your Mac can show up in Windows as a drive, live: what you change
on one side is there on the other at once. In the app, open the details panel
and use **Shared folder → Choose Folder…**; **Stop sharing** ends it. Windows
shows the folder as **Mac (Z:)** in File Explorer.

```sh
winvm share set ~/Projects               # share this folder, as Z:
winvm share set ~/Projects --letter Y    # as Y: instead
winvm share set ~/Downloads --readonly   # Windows can read it but not change it
winvm share clear                        # stop sharing
winvm share status                       # what is shared; --json for scripts
```

Things to know:

- **One folder per Windows machine.** Sharing another folder replaces the
  first.
- **A different folder takes effect the next time Windows starts.** Stop and
  start it, or `winvm stow` then `winvm start`, which keeps everything you
  had open. A new drive letter takes effect at once.
- **When nothing is shared**, Windows still shows the drive, empty and
  read-only.
- **Windows machines made before this** need a one-time setup:
  `winvm share install --restart`, or **Set Up in Windows…** in the app.
  Windows restarts twice while it installs the driver. Machines made from an
  image built with this already have it.
- It needs the resizable display (`winvm display virtio-gpu`, the default for
  new machines) and a winvm runtime with the shared folder (`share status`
  says when yours has none).
- About 850 MB/s writing and 1.3 GB/s reading a large file, measured in the
  guest.

### For developers

The folder travels over **virtio-fs**: QEMU's `vhost-user-fs-pci` device and
`virtiofsd` on the Mac, one daemon per QEMU process, started by winvm before
every boot, load or recall. Its log is `<instance>/virtiofsd.log`
(`WINVM_VIRTIOFSD_LOG=debug` for more). In Windows, **viofs** (virtio-win's
driver and its `VirtioFsSvc` service) mounts it through **WinFsp**.
`share.ts` has the devices and the daemon, `sharecmds.ts` the verbs, and
[How the VM is configured](windows-vm-qemu.md#the-shared-folder-and-the-clipboard)
the reasons.

**File watchers.** virtio-fs does not tell Windows when a file changes on the
Mac, so programs watching the folder (editors, dev servers, Explorer) would
miss those changes. winvm's control service watches the folder on the Mac and
asks the in-guest agent to touch each changed path in the drive
(`sharewatch.ts`, the agent's `POST /fs/touch`), which makes Windows report
it, as Lima does for Linux guests. Watchers see a *changed* event about a
second later: a new Mac file arrives as "changed", not "created", and a
deleted one as a change to its folder. This needs the in-guest agent and a
writable share.

## Clipboard

Text you copy in Windows can be pasted on the Mac, and the other way round,
while the winvm app's window is in front. Text only for now. It needs the
resizable display, a runtime with the clipboard channel, and the SPICE agent
in Windows, which the UTM guest tools install (every winvm image has them).

## Over the network

The guest reaches the host at `10.0.2.2`. For large files or whole folders,
serve them on the host and download them in the guest:

```sh
# on the host, in the folder to share
python3 -m http.server 8000 --bind 127.0.0.1

# in the guest
winvm exec -- curl.exe -o 'C:\work\maximal-setup.msi' http://10.0.2.2:8000/maximal-setup.msi
winvm exec -- msiexec /i 'C:\work\maximal-setup.msi' /qn /l*v 'C:\work\install.log'
```

The guest can also download from the internet directly, for example a GitHub
release. Take a `save` or `snapshot` before installing, so you can go back to
a clean guest.

## Built into the image

`winvm build --payload <dir>` copies a folder into every instance made from
that image. During the build, `.zip` files are expanded into `C:\payload`,
everything else is copied there, folders containing an `.exe` are added to
`PATH`, and `C:\payload\setup.ps1` runs if present. Changing the payload means
building the image again.

## ARM64 and x64

The guest is ARM64. x64 programs, such as Maximal's Windows build, run under
Windows' x64 emulation. That's fine for path, shell, file-locking and
installer bugs, but not for timing-sensitive ones. See
[Fidelity limits](windows-vm-qemu.md#fidelity-limits--read-before-trusting-a-result).
