# Change checklists

Recipes for common design changes. Following the checklist costs a
minute; not following one is how a value ends up hand-edited in a
generated file or inlined where a token belongs (see
[`failure-modes.md`](failure-modes.md)).

## Token value hygiene (read first)

- **Values live in `ui/src/styles/theme.ts` only.** Design docs reference
  tokens by name + purpose, never by value.
- If a doc shows a value, that's a bug — fix the doc.
- If you change a value, follow *Changing a token value* below.

## Changing a token value

1. Edit `ui/src/styles/theme.ts` (the declared ground truth). A
   color that differs between light and dark goes in **both**
   `themes.dark` and `themes.light`.
2. Run `mise run tokens:generate`. It rewrites `ui/src/styles/tokens.css`,
   which every window's stylesheet imports (through `styles.css`). Never
   hand-edit it; the viewer's `typecheck` fails when it is stale.
3. Search for any inlined raw value the token was supposed to replace:
   `grep -rn '<old-value>' apps/viewer/ui/src packages/canvas/src
   packages/storybook/src`. `scripts/check-design-tokens.ts` (in the
   viewer's `typecheck`) already fails a raw color in their stylesheets,
   but not one in a `.ts` or `.tsx` file.
4. Manually verify every window (main, Files, Terminal) in the app:
   `mise run build`, then `mise run dev`.
5. If the change is a color, run `bun run storybook:check` (includes
   the contrast audit across all three surfaces in **both** themes) per
   [`color.md`](color.md). Storybook's Theme toolbar (System / Dark /
   Light) is the quickest way to look.

## Adding a new token

1. Confirm there isn't an existing token that fits. Check
   [`tokens.md`](tokens.md).
2. Add the row to [`tokens.md`](tokens.md) **first**, with `Purpose`,
   `Use for`, `Do NOT use for` filled in. A token without a clear
   role is a future drift source.
3. Declare it in `ui/src/styles/theme.ts` and run `mise run
   tokens:generate`. A key in an existing group is written out as it
   is; a new group also needs a line in `tokensCss()` in
   `scripts/generate-css-tokens.ts`.
4. Use it. Don't inline the value anywhere else.

## Adding a new component

1. Read [`aesthetic.md`](aesthetic.md) → *When to use a card* before
   reaching for card chrome. Most "new components" should be
   typography + spacing.
2. Reference [`components.md`](components.md) for existing dimensions
   (heights, padding, fonts). If the component fits an existing
   pattern, match it exactly; novelty costs visual cohesion.
3. All measurements: token references only. No inline `px`/`rem`/`#hex`.
4. Focus ring: `:focus-visible`, never `:focus`. Use the
   `--focus-ring` composed token (see [`components.md`](components.md)
   → *Focus rings*).
5. Hover/active transitions: 150ms ease-out. Wrap in the global
   reduced-motion block ([`motion.md`](motion.md)).
6. Add stories under `packages/storybook/src/` covering each visual
   state (not just the happy path): `components/` or `viewer/` for a
   component rendered from source with fixture props, `windows/` for a
   state of the built window driven through the render fakes. Check
   them in both themes; `bun run storybook:shots` captures every story
   in light and dark.

## Adding or modifying a color role

1. Read [`color.md`](color.md) → *Why the split exists*. The four
   roles (brand, accent, destructive, link) earn their separation;
   don't collapse them.
2. If proposing a new role (e.g. a fifth color), justify it against
   the existing four. If "I want a different teal for X" is the
   reason, the answer is probably "use `--accent`."
3. Pick values that pass on all three surfaces in both themes (WCAG
   AA: 4.5:1 for text, 3:1 for controls). A color that must work as
   text and as a fill should pass as text on its own; don't add a
   separate foreground-pairing token.
4. Add the tokens to `theme.ts` (both `themes.dark` and
   `themes.light` if they differ per theme), run `mise run
   tokens:generate`, then `bun run storybook:check`.
5. Update [`tokens.md`](tokens.md) and [`color.md`](color.md).

## Wiring a keyboard binding

1. Check [`keyboard.md`](keyboard.md) — confirm the binding isn't
   already **shipped** (don't duplicate) or **reserved** (don't
   repurpose, especially `Cmd-K`).
2. Choose scope:
   - **Native menu** → an accelerator on the `MenuItem` in `menu()`
     (`src-tauri/src/lib.rs`), handled in `handle_menu`; whether the
     main window's items are enabled is
     `ui/src/features/toolbar/nativeMenu.ts`.
   - **Per-window** → `keydown` listener in the window's frontend
     code (`ui/src/App.tsx` and `ui/src/features/` for the main window,
     `ui/src/features/files/FilesWindow.tsx`,
     `ui/src/features/terminal/TerminalWindow.tsx`).
3. Cross-platform: `event.metaKey || event.ctrlKey`.
4. Add the tooltip affordance on the corresponding visible control,
   keybind in parens: `Settings (⌘,)`.
5. Update [`keyboard.md`](keyboard.md) status: `planned` → `shipped`.

## Adding a window

1. Read [`windows.md`](windows.md) → *The Files window* and *The
   Terminal window*.
2. Add the window builder (`WebviewWindowBuilder`) in
   `src-tauri/src/lib.rs`, its size and minimum in
   `src-tauri/src/windows.rs`, and its HTML page to the entrypoints in
   `scripts/build-ui.ts`.
3. Add to the window-sizes table in [`layout.md`](layout.md).
4. Single-instance behavior: if the window is already open, unminimize,
   show and focus it instead of building another (`show_terminal`,
   `files_open`; the Files window is one per machine).
5. Tokens: the page's stylesheet imports `styles.css`, which imports the
   generated `tokens.css`, as `files.css` and `terminal.css` do. Never
   hand-declare token values.
