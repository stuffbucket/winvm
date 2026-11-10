# Devices and Windows authentication

QEMU + Hypervisor.framework remains the supported backend. This is a capability
boundary and implementation guide, not a claim that physical devices have been
tested. No real device, account enrollment, or Windows sign-in scenario was
exercised for this audit (2026-11-04).

## What works now

- Emulated USB keyboard/tablet and a software TPM 2.0 (`swtpm`). These are **not**
  host USB passthrough or Apple Secure Enclave/Touch ID integration.
- Windows networking, the screen and ordinary keyboard input. Input → Send
  Ctrl-Alt-Delete can deliver the secure-attention keys; it does not authenticate
  or bypass Windows security.
- Text clipboard and explicit file/folder transfers (see [screen](screen.md)
  and [the guest agent](agent.md)). The app currently uses VNC, not a native
  SPICE display client. There is no SPICE image clipboard, microphone or USB
  channel hidden behind a missing checkbox.
- Settings reuses the existing CPU/memory controls and reports disk capacity
  and shared NAT addresses. Hardware changes apply at the next cold boot;
  restoring a checkpoint uses its recorded hardware.
- Pause, Sleep/Wake and suspended-to-disk sessions are winvm policies, not
  Windows S3/Modern Standby. Sleep locks Windows before pausing QEMU; memory
  remains on the Mac. Stow saves a session and exits QEMU. Settings controls
  idle autosave, retention, idle stow, and the optional keep-awake assertion.

## The runtime is the boundary

The pinned runtime **11.1.2-2**, source commit
[`b03e34552305abd0c2883e42e24141dd32bfe052`](https://github.com/stuffbucket/winvm-runtime/blob/b03e34552305abd0c2883e42e24141dd32bfe052/Formula/winvm-qemu.rb#L65-L107),
explicitly disables CoreAudio, SDL, libusb, usb-redir and spice-server.
`--enable-spice-protocol` supplies protocol headers; it does not enable a SPICE
server/client. `qemu.ts` adds no host audio/camera/Bluetooth transport. Do not
add optimistic launch flags or enabled-looking settings for these capabilities.

| Need | Established candidate | Current limit |
| --- | --- | --- |
| Sound output | CoreAudio + Intel HDA / `hda-output` | Requires runtime build, fixed guest device and Windows ARM64 driver/save acceptance |
| Microphone | UTM-style SPICE Record + Playback and `hda-duplex` | QEMU CoreAudio is **playback-only**; noVNC is not an audio capture client |
| Selected host USB / FIDO2 key | libusb `usb-host`, or native host usbredir with guest `usb-redir` channels | Both disabled in the current runtime; needs explicit device ownership, hotplug and real hardware tests |
| Bluetooth APIs inside Windows | A dedicated USB Bluetooth dongle, exclusively redirected | Host-paired keyboard/mouse input is not a guest radio; built-in Mac Bluetooth sharing is not established |
| External USB webcam | Explicitly redirected UVC camera | Candidate only; isochronous/reset behavior and ARM64 class/vendor drivers require tests |
| Built-in Apple camera | Native capture plus a guest-visible camera transport/driver | Cannot simply be treated as an ordinary redirectable USB camera |
| Mac Touch ID | Optional host-app LocalAuthentication gate | No transparent Windows Hello/TPM bridge established; app-only gating does not secure CLI/QMP or encrypt disks |

UTM's [pinned sound arguments](https://github.com/utmapp/UTM/blob/a6e0c06957ab5a32b960499ba3a286c37852e37a/Configuration/UTMQemuConfiguration%2BArguments.swift#L707-L750)
use CoreAudio `hda-output` versus SPICE `hda-duplex`.
Its [USB redirection arguments](https://github.com/utmapp/UTM/blob/a6e0c06957ab5a32b960499ba3a286c37852e37a/Configuration/UTMQemuConfiguration%2BArguments.swift#L1010-L1015)
and [native SPICE I/O](https://github.com/utmapp/UTM/blob/a6e0c06957ab5a32b960499ba3a286c37852e37a/Services/UTMSpiceIO.m)
show why this is native runtime/client work, not just frontend controls.
[UTM USB guidance](https://github.com/utmapp/docs.getutm.app/blob/4cf17c9569dcb616b9d7f156a103cc8a19027fe6/guest-support/sharing/usb.md)
also documents capture/reset limitations and built-in Apple webcam exclusions.
QEMU's [CoreAudio driver](https://github.com/qemu/qemu/blob/4fc49f46dc95d4a27de2509e7fceb2931e91faeb/audio/coreaudio.m#L653-L662)
sets `max_voices_in = 0`.

[usbredir is SPICE-independent](https://www.spice-space.org/usbredir.html), so a
separate native host bridge could retain VNC display. That is an alternative
to evaluate, not an implemented transport. Avoid accidentally growing two
incompatible clipboard/audio/device stacks.

## A normal Windows sign-in profile is separate work

The current image intentionally boots audit-mode Administrator with automatic
sign-in and disabled UAC/locking policies. See
[the Windows/QEMU contract](windows-vm-qemu.md), `assets/autounattend.xml`,
`assets/logon.ps1`, and the interactive-readiness/recovery path in `qga.ts`.
**Do not disable autologin as a standalone setting:** readiness currently
assumes an interactive audit desktop and may repair an interrupted audit boot.
A locked or awaiting-sign-in guest must not be mistaken for a broken install.

A supported interactive profile needs to finish provisioning/leave audit mode,
create an ordinary account through Windows, re-enable UAC/locking, preserve
agent service access, and distinguish booted, awaiting sign-in and desktop
ready. Existing instances/saves must keep their current behavior unless the
person explicitly migrates them. Never collect Windows passwords or PINs in
app settings, command lines, logs, or automatic clipboard synchronization.

TPM emulation alone does not establish Windows Hello enrollment, Secure Boot,
hardware attestation or biometrics. A USB FIDO2 key used on a website is also
not automatically a local Windows account-unlock device; Microsoft's
[Windows security-key sign-in requirements](https://learn.microsoft.com/en-us/entra/identity/authentication/howto-authentication-passwordless-security-key-windows)
include the relevant Entra/device policies. QEMU's
[U2F passthrough](https://www.qemu.org/docs/master/system/devices/usb-u2f.html)
uses Linux hidraw/libudev, not a macOS CTAP2/passkey bridge. ARM x86/x64
user-mode emulation does not cover kernel drivers: vendor devices need signed
ARM64 drivers (or a suitable Windows inbox class driver).

## Permissions, ownership and checkpoint safety

- Request microphone/camera access only after an explicit user action; handle
  denial/revocation. Configure the usage descriptions and hardened-runtime
  entitlements on the actual native capture owner, not just on QEMU's HVF
  entitlement file. [Apple media-capture consent](https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos)
  is separate from hypervisor permission. An App Sandbox USB entitlement is
  not a universal host-device-access entitlement.
- Explicit Connect/Disconnect and one VM owner per physical device. No
  auto-connect-all policy, broad HID capture or silent USB storage removal to
  allow autosave. usbredir automatic filters do not constrain every manual
  selection; enforce ownership/consent at the attachment boundary too.
- Physical device state is not rolled back with RAM. QEMU
  [libusb restore](https://github.com/qemu/qemu/blob/4fc49f46dc95d4a27de2509e7fceb2931e91faeb/hw/usb/host-libusb.c#L1706-L1758)
  models surprise removal/rescan, and
  [usbredir restore](https://github.com/qemu/qemu/blob/4fc49f46dc95d4a27de2509e7fceb2931e91faeb/hw/usb/redirect.c#L2308-L2319)
  may report disconnection. Do not promise uninterrupted physical-device
  sessions merely because virtual device state is migratable.
- Hardware launch arguments enter the save compatibility hash. Dynamic
  hotplug is not automatically represented there. Runtime compatibility also
  needs deliberate versioning when configure features/patches change; merely
  retaining the same upstream QEMU version is insufficient assurance.
- Saves contain RAM, software TPM and potentially logged-in credentials. They
  are sensitive state; compression/protection against reclamation is **not
  encryption**. Cloning and rollback have identity/security implications.

## Code-Hex is useful precedent, not a Windows VZ backend

The relevant reference is the [Code-Hex/vz wiki](https://github.com/Code-Hex/vz/wiki).
Its [macOS 15 attach/detach example](https://github.com/Code-Hex/vz/wiki/Attach-Detach-USB-Device-example-for-macOS-15-and-above)
uses image-backed USB mass storage, not general physical USB forwarding.
The [pinned physical passthrough APIs](https://github.com/Code-Hex/vz/blob/3deac7ce9df25ea2e5421c9e3e410d48cae4ca5b/usb_passthrough.go#L60-L69)
require macOS 27, a Dock app, accessory entitlement and user assignment—not
winvm's macOS 15 contract. They do not change the supported Windows/QEMU choice.

## Delivery order

1. Runtime capability manifest/probes and explicit compatibility versioning.
2. Output-only CoreAudio/HDA acceptance, without mutating old saved hardware.
3. Selected-device USB attachment/ownership and a conservative save policy.
4. Duplex native audio capture, then exact external UVC/BT-dongle/FIDO2 tests.
5. A separately specified interactive Windows/authentication profile.

Until these pass runtime, guest-driver, permissions and save/load acceptance,
Settings explains the limits rather than exposing nonfunctional switches.
