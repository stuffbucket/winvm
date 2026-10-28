# Getting files in and out

## `put` and `get`

```sh
winvm put build/maximal-setup.msi 'C:\work\maximal-setup.msi'
winvm get 'C:\work\install.log' install.log
```

These copy one file through the in-guest agent, or through the QEMU guest
agent if the in-guest agent isn't running. The instance has to be running.

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
