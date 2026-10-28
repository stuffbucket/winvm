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
