# Changelog

## [0.1.3](https://github.com/stuffbucket/winvm/compare/v0.1.2...v0.1.3) (2026-11-03)


### Features

* **agent:** keep the display helper running, and report memory and C: ([74bcc3a](https://github.com/stuffbucket/winvm/commit/74bcc3a34d8aef4993f7d72ec12ab50bb7a383a8))
* **agent:** list guest folders, and copy folders out with get ([d60ffe7](https://github.com/stuffbucket/winvm/commit/d60ffe7c5a0fccad8a2581bdf3232f6acb5a28fb))
* **agent:** terminals over a WebSocket on GET /term ([832de3c](https://github.com/stuffbucket/winvm/commit/832de3c3a54f734e20d8d2bb1e1235fd3dc82770))
* **app:** a Terminal window with tabs of shells in Windows ([539f004](https://github.com/stuffbucket/winvm/commit/539f00497e041fb53445f97ab394650e2c0c9548))
* **app:** call a machine's agent directly, through winvm agent connect ([98e309f](https://github.com/stuffbucket/winvm/commit/98e309f39b71f313353bb7109b337d5304fc8c3e))
* **app:** rename Terminal tabs and the window, per instance ([d1ee3fc](https://github.com/stuffbucket/winvm/commit/d1ee3fceabb5e7e85dae7df4a92ddd9194499781))
* **app:** smooth live resize, Resources in the panel, a Windows machines menu ([579bb74](https://github.com/stuffbucket/winvm/commit/579bb749e32b5df8a4fb577e60b1b5b2748e9bc2))
* **app:** Terminal offers only installed shells, tabs in the title bar ([cb9765f](https://github.com/stuffbucket/winvm/commit/cb9765fc9bd9640d6ad8b2792623f458d32bcba1))
* **canvas:** vendor monimal's spatial canvas as @winvm/canvas ([f296a08](https://github.com/stuffbucket/winvm/commit/f296a08caaf905e8653959acef98cc29fc1c149b))
* **cli:** put copies a folder and everything in it ([9596ea7](https://github.com/stuffbucket/winvm/commit/9596ea7a308178033098804d1bb01a960868ca6a))
* **cli:** winvm create, ls --json, and plain names for new instances ([9ff0b6d](https://github.com/stuffbucket/winvm/commit/9ff0b6d6e24be1908ed5479bc54c906ce087d408))
* **cli:** winvm terminal --shells says which shells the guest has ([4fdfcf0](https://github.com/stuffbucket/winvm/commit/4fdfcf0f5aeeb5de666f408522d88789cde4044d))
* **cli:** winvm terminal, a guest shell in this terminal ([2dc6b75](https://github.com/stuffbucket/winvm/commit/2dc6b7567225ea904d8f88f12dd7efc3a09630e9))
* **core:** a screenshot with every save, and notes in the XDG data dir ([002e0f6](https://github.com/stuffbucket/winvm/commit/002e0f6bcbe22781fc7ed830d8ac4deeca3ecebe))
* **core:** agent 11 says how busy Windows' processors are in GET /stats ([9bda0b0](https://github.com/stuffbucket/winvm/commit/9bda0b0ede174cf575b5fcf6f40205fe387d419b))
* **core:** agent version 10, with both /smb/setup and /fs/touch ([da1d717](https://github.com/stuffbucket/winvm/commit/da1d717f29e0d6f512151a1e74ab7da87680a94e))
* **core:** an instance title, kept in config.json and shown in status ([97a3696](https://github.com/stuffbucket/winvm/commit/97a3696d3eab10c8e031e62926606efa2d14225e))
* **core:** forward the guest's SMB port and set up file sharing through the agent ([c27a1b6](https://github.com/stuffbucket/winvm/commit/c27a1b63d8f948d4d634cab66a89f0c86fdaa3d6))
* **core:** let QEMU's VNC server send JPEG to clients that ask (lossy=on) ([06cffb8](https://github.com/stuffbucket/winvm/commit/06cffb8c56fbb8d42849e34bbc278abfc64a7e2f))
* **core:** make, rename, move, copy and recycle guest files (agent v7) ([95eb873](https://github.com/stuffbucket/winvm/commit/95eb87354e182a1b352f17afeff241fe80d6d8ed))
* **core:** mount the guest's drives in Finder with winvm files ([a5e6dec](https://github.com/stuffbucket/winvm/commit/a5e6decedd5bfee4d9f6e4f2a06db0acf7b5f5be))
* **core:** resize virtio-gpu guests live and make it the default display ([ee1493a](https://github.com/stuffbucket/winvm/commit/ee1493a93652ccb687b93a5e8f76f9648d7f084f))
* **core:** serve the guest to Claude Code and Claude Desktop over MCP ([34133fc](https://github.com/stuffbucket/winvm/commit/34133fcf0788fcf110d8b47651f0976d1091f00b))
* **core:** share a Mac folder with Windows over virtio-fs, and carry the clipboard ([f382f41](https://github.com/stuffbucket/winvm/commit/f382f412ad18e94aadbedc874d96241eba254388))
* **core:** sleep, wake and lock verbs, and user settings in XDG config ([70f5a9f](https://github.com/stuffbucket/winvm/commit/70f5a9f57efd86af4c2f3e5e0cf962cad99df0c2))
* **core:** winvm agent connect prints the agent's address and token ([00036a2](https://github.com/stuffbucket/winvm/commit/00036a28322b218c55212e4fb496eddca562a079))
* pin winvm-runtime 11.1.2-2, with the shared folder and clipboard ([140f07b](https://github.com/stuffbucket/winvm/commit/140f07b4d8cff122d4335700f71ffd78d6fa39db))
* set a machine's processors and memory, and show its network ([ec63393](https://github.com/stuffbucket/winvm/commit/ec63393b016aae1abd8be747367085a9e974180d))
* **terminal:** bring xterm's stylesheet and keep the grid while hidden ([924a26b](https://github.com/stuffbucket/winvm/commit/924a26bc37f5aed48f1b83ac0beb73376b830495))
* **terminal:** vendor monimal's terminal renderer as @winvm/terminal ([e4a70da](https://github.com/stuffbucket/winvm/commit/e4a70da6af15545235a31559fe8a45c519f77a06))
* **viewer:** a Files window in place of the Files sheet ([0654a5a](https://github.com/stuffbucket/winvm/commit/0654a5a71c1fb4fc05e7f3caf90517f72bfb4f6c))
* **viewer:** a Shared folder section, and the clipboard with the Mac ([7bd8154](https://github.com/stuffbucket/winvm/commit/7bd8154f3007b2a6c19a308ed8eca5279927ddb0))
* **viewer:** browse the guest's files and copy with native panels ([315459f](https://github.com/stuffbucket/winvm/commit/315459fac096281f0bb87690ab770d8e90f562a7))
* **viewer:** Checkpoints, every checkpoint on a full-window canvas ([90582e1](https://github.com/stuffbucket/winvm/commit/90582e1e9e22582a0ad78d312c5041d6a229a567))
* **viewer:** drag guest files out to Finder as file promises ([4331db0](https://github.com/stuffbucket/winvm/commit/4331db088395e72500be37146738963b0a6e9da9))
* **viewer:** make a virtio-gpu guest's screen follow the window, pixel for pixel ([64487e8](https://github.com/stuffbucket/winvm/commit/64487e8b3eb92f686fbd4002cadef3bd83dac0e7))
* **viewer:** open Windows' home folder and C:\ in Finder ([6222920](https://github.com/stuffbucket/winvm/commit/6222920d1921bf453bc174fe8d5738880ebff658))
* **viewer:** Option-click on Files in Windows offers places to open ([155af58](https://github.com/stuffbucket/winvm/commit/155af5856153fad2ce3aa5267d315db270ea6300))
* **viewer:** scale the screen up to fill a window past the guest's limits ([aa2c718](https://github.com/stuffbucket/winvm/commit/aa2c718e341a9d45e383ab6ddaaa17119c802a6a))
* **viewer:** turn "Share with an agent" into "Use with Claude" ([056510e](https://github.com/stuffbucket/winvm/commit/056510ea2c07bc43dea8ab2a99bfee070d499d68))


### Bug Fixes

* **app:** drop tabs never taken when the Terminal window closes ([7f71c19](https://github.com/stuffbucket/winvm/commit/7f71c19a308d5325069b47a9c557055d15da03e8))
* **app:** fill the window with the guest's screen by default ([2cc63f9](https://github.com/stuffbucket/winvm/commit/2cc63f9841476f49c525acad76209606a307bebf))
* **cli:** winvm terminal in an unsized pty opens at 80x24 ([7a49d05](https://github.com/stuffbucket/winvm/commit/7a49d050d0b754e136eb0dde0bb734428a0374aa))
* **core:** a QEMU pidfile gone mid-read means not running, not an error ([370e15c](https://github.com/stuffbucket/winvm/commit/370e15c44193190e9c8dd36619ff6b29e763e4a1))
* **core:** a save of a running guest shows as running, and Finder's drives refuse a frozen guest ([c64b6c8](https://github.com/stuffbucket/winvm/commit/c64b6c805993fd903dc20e0b461a57d1c8d8b05c))
* **core:** keep a paused guest paused and leave it alone ([9db91b2](https://github.com/stuffbucket/winvm/commit/9db91b2844aa128273eeafec03cbbace8e2b15e5))
* **core:** keep share install --json's stdout to one JSON object ([1bea470](https://github.com/stuffbucket/winvm/commit/1bea47060647bbab0a8dee9caba2cf966f98e8a0))
* **core:** set a screen size Windows refuses at its lock screen once someone signs in ([4cf3ea7](https://github.com/stuffbucket/winvm/commit/4cf3ea78c674f79b6ea1d37ad14f592af34fa57e))
* **core:** work out the firmware directories once per state directory ([76bf896](https://github.com/stuffbucket/winvm/commit/76bf89601fe7dd4c05df99787de4b9d138ef1ed4))
* name stuffbucket as the copyright holder in LICENSE ([ca46a33](https://github.com/stuffbucket/winvm/commit/ca46a33d044e38fe99ac040371c1715ddaa77cde))
* **viewer:** bundle React's production build for both windows ([6a202c7](https://github.com/stuffbucket/winvm/commit/6a202c72b74aededf9944646795c4bd75c45c69f))
* **viewer:** keep a window size Windows can't take yet, and ask again with both steps ([ff1f979](https://github.com/stuffbucket/winvm/commit/ff1f979c20fd02a3f3dcb9ff61b11d21c30b89cf))
* **viewer:** keep one agentFetch in backend.ts ([c95640b](https://github.com/stuffbucket/winvm/commit/c95640b47b166e6731d8e1db97c349ab278ed681))
* **viewer:** keep Pause true to the machine; add Sleep, Lock and a pause overlay ([64b3bd2](https://github.com/stuffbucket/winvm/commit/64b3bd26bf314da064e36b8ab63873f8d2499267))
* **viewer:** keep QEMU's VNC refresh from backing off ([4c6be0c](https://github.com/stuffbucket/winvm/commit/4c6be0ceaceb27ba0ebdd05157cd4fe37fb31e26))
* **viewer:** keys and flights in Checkpoints after a dialog or a load ([f8d811e](https://github.com/stuffbucket/winvm/commit/f8d811e125b0a84ab1d6616bd473eafff50a782b))
* **viewer:** lead the CPU meter with Windows' own figure ([460d03e](https://github.com/stuffbucket/winvm/commit/460d03ec579172167d8ef1b979daabf33c6beb55))
* **viewer:** one writer for settings.json, so the pause overlay and Checkpoints keep each other's keys ([fa125a3](https://github.com/stuffbucket/winvm/commit/fa125a3a6cf5f0a9a920eb8f258b6f6b68448e1b))
* **viewer:** opaque chrome over the Checkpoints canvas, so a card's text never shows through the title ([692f355](https://github.com/stuffbucket/winvm/commit/692f3554d1090687adfe2376b29635627fe2700f))
* **viewer:** plainer power confirmations ([e70ce43](https://github.com/stuffbucket/winvm/commit/e70ce43f29cc4f9ee6d9927462e26db36a8b5029))
* **viewer:** prevent stray Windows key presses ([d3599c3](https://github.com/stuffbucket/winvm/commit/d3599c35b4000aed5891d9adb1eb5bbc6327b4f9))


### Performance Improvements

* **viewer:** the Files window calls the guest's agent directly ([fb053f7](https://github.com/stuffbucket/winvm/commit/fb053f7c4ba9d9a4f86cdae52c5bdb9fe5f0366a))

## [0.1.2](https://github.com/stuffbucket/winvm/compare/v0.1.1...v0.1.2) (2026-10-28)


### Features

* **app:** check for updates and install them in place ([c9b1bba](https://github.com/stuffbucket/winvm/commit/c9b1bba79e18b791fdccd2e35d01a7a37f0d624f))


### Bug Fixes

* **cli:** list ui and --pool in winvm help ([3121e18](https://github.com/stuffbucket/winvm/commit/3121e188ac8d32e3d25a30021d69c304029025ea))

## [0.1.1](https://github.com/stuffbucket/winvm/compare/v0.1.0...v0.1.1) (2026-10-28)


### Bug Fixes

* **qga:** ask the agent who is logged on, and bound each probe ([e57ab03](https://github.com/stuffbucket/winvm/commit/e57ab03c20805284f78c36d74d972d5c96da77c7))
