# @winvm/terminal

A terminal view for React on xterm.js. It talks to its shell through a
`TerminalTransport` you pass in, so it has no idea where the shell runs. The
winvm app's Terminal window gives it a WebSocket to a shell in the Windows
guest (`apps/viewer/ui/src/features/terminal/socket.ts`).

## Where it came from

The renderer half of monimal's `packages/maximal-terminal`, at monimal commit
`fb29a8d` (github.com/stuffbucket/monimal):

| Here | monimal |
| --- | --- |
| `src/TerminalView.tsx` | `src/renderer/TerminalView.tsx` |
| `src/transport.ts` | `src/renderer/transport.ts` (`TerminalTransport`, `createTerminalTransport`, `readTerminalTheme`) |
| `src/emulator.ts` | `src/renderer/emulator.ts`, xterm adapter only |
| `src/appearance.ts` | `src/renderer/appearance.ts` |
| `src/ack.ts` | `src/renderer/ack.ts` |
| `src/tab.ts` | `src/renderer/tab.ts` |
| `src/pane.ts` | `src/pane.ts` |
| `tests/*.test.ts` | `tests/renderer/{ack,appearance,tab,transport}.test.ts`, moved from Vitest to `bun:test` |

monimal is stuffbucket's own private repository, with no license file. This
copy is vendored by the same owner and published under winvm's MIT license.

## What was left out

- **The host side**: `TerminalHost`, the `node-pty` connector,
  `registerTerminalChannels`, the launcher and its connectors, and
  `src/contract.ts` (the pty IPC request shapes). winvm's shells run in the
  guest, behind `winvm terminal`.
- **tmux** control and projection, and the **Electron** adapter.
- **The Ghostty emulator** (`@wterm/dom`, `@wterm/ghostty` and its WebAssembly
  core) and `osc-title.ts`, which only it used. Asking for `emulator="ghostty"`
  gets xterm.
- **Detach and splits**: `sessions.ts`, `useDetachedTerminals.ts`,
  `workspace.ts`, `usePaneTree.ts`. The types `TerminalView` names for them
  (`DetachableTerminalTransport`, split callbacks) are still here.
- monimal's lint, mutation testing and jsdom view tests.

## Changed here

- `TerminalView` takes `labels` for its start-failure notice, so the app's
  catalog supplies the words.
- The xterm adapter applies `TerminalTypography`'s family, point size, weight
  and leading. In monimal only the Ghostty adapter did.

To take a newer monimal, diff its `src/renderer` against these files and
carry the two changes above across.
