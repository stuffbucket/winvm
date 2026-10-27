# Design rules

These are maximal v0.4.48's design rules (`docs/design/`), copied as they
are so the winvm window and maximal's windows follow one design language.
Where they name maximal's Settings window, read the winvm window; where
they name maximal's files, the winvm equivalents are:

| maximal | winvm |
|---|---|
| `shell/src/ui/styles/theme.ts` | `apps/viewer/ui/src/styles/theme.ts` |
| `shell/src/ui/styles/tokens.css` (generated) | `apps/viewer/ui/src/styles/tokens.css`, by `bun scripts/generate-css-tokens.ts` |
| `shell/src/ui/styles/styles.css` | `apps/viewer/ui/src/styles/styles.css` |
| `shell/src/ui/components/` | `apps/viewer/ui/src/components/` |
| `shell/src/i18n/` | `apps/viewer/ui/src/i18n/` |
| `scripts/check-design-tokens.ts` | `apps/viewer/scripts/check-design-tokens.ts` |

[`windows.md`](windows.md) is winvm's own: it describes the winvm window.
`pnpm typecheck` in `apps/viewer` checks that `tokens.css` matches
`theme.ts` and that the stylesheet follows the token rules.
