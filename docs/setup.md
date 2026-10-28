# Setting up

## The Windows ISO

Use the **Windows 11 ARM64** multi-edition ISO in English (United States).
Download it from
<https://www.microsoft.com/en-us/software-download/windows11arm64>. No
sign-in is needed, and the download link expires after 24 hours. winvm was
developed against 25H2 (`Win11_25H2_English_Arm64_v2.iso`). An x64 ISO is
rejected.

`build` installs Windows 11 Pro with Microsoft's generic key, so Windows stays
unactivated.

Tell `build` where the ISO is in one of these ways:

1. `winvm build --iso <path>`
2. `export WINVM_ISO=<path>`
3. Put it in `~/vm/` or `~/isos/` (or one folder below) with `arm64` in its
   name. `build` uses it if it's the only match.

Don't keep it in `~/Downloads` or `~/Desktop`. macOS asks for permission
before a program reads those folders. winvm links to the ISO and never copies
it; later builds reuse the link.

## Building an image

```sh
winvm setup                              # guest tools and PowerShell 7 (and, from source, QEMU)
winvm build --iso <path>                 # about 20 minutes, unattended
winvm build --iso <path> --bun 1.3.14    # also put that Bun release in C:\payload
winvm build --iso <path> --payload <dir> # also copy <dir> into C:\payload
```

`setup` downloads UTM's guest tools ISO (virtio drivers and the QEMU guest
agent) and the PowerShell 7 installer. You don't need UTM itself.

The image also gets PowerShell 7, the in-guest agent, and settings that keep
Windows quiet (Windows Update, indexing and telemetry off). The details are in
[How the VM is configured](windows-vm-qemu.md#what-the-image-carries-and-why-it-is-quiet).

The default image is `win11-arm64`. Use `--image <name>` (or `WINVM_IMAGE`)
to build or use another. `build` won't replace an image that exists or that an
instance still uses. `winvm rmi <image>` removes one.

## Instances

An instance is a copy-on-write overlay on an image. It keeps the image it was
created with.

```sh
winvm start -i test               # create and start instance "test"
winvm start --ephemeral           # discard everything when it stops
winvm reset -i test               # discard changes, back to the image
winvm destroy -i test             # remove it and its saves
winvm ls                          # images and instances, with disk use
```

## Screen size

New instances use a resizable display (virtio-gpu). In the app, the Windows
screen follows the window: it is the window's size in real pixels, with
Windows scaling set to match your Mac (200% on a Retina display), so it is
sharp. Nothing to set up.

From the command line, while the instance runs:

```sh
winvm display -i test                    # device, size and scaling now
winvm display -i test 2560x1600          # resize, live, in well under a second
winvm display -i test --scale 200        # Windows display scaling, live
```

Sizes are kept to what the guest can show: up to 5120 wide and 2160 tall, and
at most 30 MiB of picture (3840x2048 fits; a bigger request is shrunk to fit,
keeping its shape). Windows' smallest is 1024x768. In the app, a window bigger
than that, such as full screen on a 5K display, keeps Windows at the largest
size that fits and scales the picture up to fill the window, up to 5K.

**Instances made before this** keep the fixed 800x600 display (ramfb), so
their saves keep loading. To switch one, stop it first:

```sh
winvm stop -i test
winvm display -i test virtio-gpu         # or: winvm display -i test ramfb
winvm start -i test
```

Saves taken on the other display won't load after a switch. winvm says which,
keeps them, and loads them again if you switch back. A stowed instance must be
started and shut down cleanly before it can switch. The first start on
virtio-gpu comes up at 1024x768 until the app (or `winvm display WxH`) sizes
it.

For developers: how the resize works, and why the size is never on QEMU's
command line, is in [How the VM is configured](windows-vm-qemu.md#the-display).

## Time Machine

The VM disks are large and change all the time. Keep them out of backups:

```sh
winvm timemachine          # report, and offer to exclude each folder
winvm timemachine --yes    # exclude without asking
```

This excludes the state directory and the folder holding the ISO.
`tmutil removeexclusion <path>` undoes it. Local Time Machine snapshots ignore
exclusions and hold on to overwritten disk blocks until macOS removes them,
usually within a day. `winvm timemachine` lists them and shows how to remove
them.

## After updating winvm

Restart anything an older version started: run `winvm web --stop`, and stop
and start any running instance. `winvm status` shows what's running.

## Troubleshooting

Start with `winvm diagnose -i <name>`. It reads the instance's files and
explains what went wrong. The troubleshooting section of
[How the VM is configured](windows-vm-qemu.md) covers more.

If `setup` or `build` says the guest tools ISO doesn't match its pin, UTM has
published a new build. Review it, then update `TOOLS_SHA256` in
`packages/core/src/host.ts`.

Linaro's guide is the closest upstream match for this setup:
<https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system>
