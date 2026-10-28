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

## Open Windows' drives in Finder

Windows' C:\ drive and your Windows home folder can show up in Finder like any
other folder, so you can open, drag and save files there with Mac apps.

In the winvm app, Option-click (or right-click) the Files button and choose
**Open in Finder: Home** or **Open in Finder: C:\\**. In a Files window, the
menus have **Open in Finder** for the folder you're in. From a terminal:

```sh
winvm files open                 # your Windows home folder, in Finder
winvm files open c               # all of C:\
winvm files open --path 'C:\work\logs'   # that folder
winvm files status               # what's mounted, and where
winvm files unmount              # take them out of Finder
```

The first time takes several seconds more: winvm sets Windows up to share its
files with your Mac (below). After that, opening is quick.

The drives appear in `~/winvm/<machine>/Home` and `~/winvm/<machine>/C`. They
don't show on the desktop or in Finder's sidebar; drag the folder to the
sidebar if you want it there.

**They come and go with Windows.** When the machine stops, is stowed, paused,
restarted, or goes back to a save, its drives are taken out of Finder first,
and put back once Windows is running again. `winvm files unmount` takes them
out for good, until you open them again. An automatic save keeps them.

**The first time an app opens them, macOS asks** whether it may use files on
a network volume. That's these drives: allow it, once per app.

**Finder leaves `.DS_Store` files** in the Windows folders it opens, as it does
on any network drive. They're harmless. To stop it on every network drive:
`defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool true`,
then log out and in.

### Security

Only your Mac can reach these drives, and only while the machine runs:

- Windows gets an account, `winvm-share`, with a random password of 24 bytes
  kept in `<instance>/smb.json` on the Mac (readable only by you). It is an
  administrator, so it can reach every file, but it can't sign in anywhere
  but over the network: interactive, Remote Desktop, batch and service logons
  are all denied before it's ever enabled, so no profile is ever made for it.
  It doesn't appear on the sign-in screen.
- Windows' file sharing accepts connections from `10.0.2.2` only (the
  firewall rule `winvm-smb`), which is the address the Mac's connections come
  from. Nothing outside the Mac can reach the guest at all.
- On the Mac, the connection is to `127.0.0.1` only. The password is never on
  a command line, so `ps` doesn't show it, and it isn't put in your keychain.
- SMB signing stays on; encryption stays off (the traffic never leaves the Mac).

### For developers

- **Guest setup** is the agent route `POST /smb/setup` (guestagent.ts
  `smbSetupScript`), with the password in the body. It is idempotent: it
  creates or resets `winvm-share`, denies its logons with `secedit`, adds it
  to Administrators, hides it (`SpecialAccounts\UserList`), sets the Server
  service to Automatic, shares `C` (`C:\`) and `Home` (`C:\Users\Administrator`)
  with full access for that account and caching off, and adds the firewall
  rule. winvm runs it the first time, and again whenever a mount is refused
  or the file server never answers: a machine made from another machine's
  save holds that machine's password, and one loaded from before the setup has
  no account at all. With UAC on, it also sets `LocalAccountTokenFilterPolicy`,
  or the account would reach the profile with a filtered token; winvm images
  run with UAC off.
- **The forward**: a host port to the guest's 445, added at runtime like the
  agent's (see [the agent](agent.md#connection)), kept in `smb.json`.
- **Mounting** uses macOS's NetFS (`NetFSMountURLSync`, through `bun:ffi`, in
  a child process so a stuck mount can be abandoned): a soft, unbrowsable
  mount exactly on the folder, with no UI and no keychain. It retries every
  half second while the file server starts, up to 30 s after a boot.
- **Unmounting** first checks the mount table (`mount`) that the folder is an
  smbfs mount of this instance's share from `127.0.0.1:<port>`, mounted on
  exactly that folder; anything else is left alone. Then `umount`, and if it's
  still there `diskutil unmount force`. (`diskutil unmount force` on a folder
  that isn't a mount point unmounts the volume holding it: for a folder in your
  home, the Mac's Data volume.) winvm never reads through the mount to check
  it: macOS stops it until allowed, and a dead server would hang it.
- **A guest that died** (QEMU killed or crashed) leaves its mounts behind. The
  idle watcher, the next winvm command, and `winvm diagnose` unmount them.
  With the server gone, macOS takes about a minute to let go of a mount, and
  nothing can hurry it; commands that only look (`status`) leave that to a
  background `winvm files _clean`.
- `winvm files status --json` reports each share's folder, whether it is
  mounted, and whether it is mounted again when the guest comes back.

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
