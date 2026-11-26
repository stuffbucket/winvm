# Proposed macos-builder change: name each build run after what it builds

Not required by winvm's release pipeline, which identifies the builder run by the
`workflow_run_id` the dispatch API returns (`return_run_details`), not by name.
It only makes the run list readable (today every run is "macOS build
(dispatched)") and makes a failed release's builder run findable at a glance.

The maintainer applies this to `stuffbucket/macos-builder`; nothing in this
repository changes the builder.

## `.github/workflows/build.yml`

```diff
--- a/.github/workflows/build.yml
+++ b/.github/workflows/build.yml
@@ -156,5 +156,6 @@
 
 name: macOS build (dispatched)
+run-name: macOS build ${{ inputs.repo }}@${{ inputs.ref }}
 
 on:
   workflow_dispatch:
```

`inputs.repo` and `inputs.ref` are validated by "Sanitize dispatch inputs", but
`run-name` is evaluated before any step runs, so it shows the raw dispatch
values. That is display only: it is never interpolated into a `run:` body, which
stays within the file's own rule that no input is.

## Not proposed, but worth knowing

- winvm's CI reads `clients/stuffbucket/winvm.policy` (a private file) to check a
  pull request's `sign_nested` against it before release. That needs a read-only
  credential, a repository secret `BUILDER_POLICY_TOKEN` in winvm (a fine-grained
  token with Contents: read on `stuffbucket/macos-builder` only). It needs no
  change to the builder.
- The policy gate sorts `sign_nested` and compares it byte for byte with
  `sign_nested_allowed`, which must therefore be stored sorted: a pin change that adds or removes a Mach-O file needs the policy PR merged
  BEFORE the winvm release PR. `scripts/preflight-signing.ts` reports the
  difference as entries added and removed.
