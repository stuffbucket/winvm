# Design rules

The viewer's design rules: its main window, the Files window and the
Terminal window. They began as a copy of maximal's design docs and now
describe winvm.

[`windows.md`](windows.md) describes the windows themselves; the other
files are the rules they share. Token values live in
`apps/viewer/ui/src/styles/theme.ts`, and `mise run tokens:generate`
writes `apps/viewer/ui/src/styles/tokens.css` from it.
`pnpm typecheck` in `apps/viewer` checks that `tokens.css` matches
`theme.ts` and that the stylesheets follow the token rules
(`apps/viewer/scripts/check-design-tokens.ts`).
