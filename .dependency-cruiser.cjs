const UI = "^(apps/viewer/ui/src|packages/canvas/src|packages/terminal/src)/"

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "ui-no-runtime-builtins",
      severity: "error",
      from: { path: UI },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "ui-no-bun-modules",
      severity: "error",
      from: { path: UI },
      to: { path: "^bun:" },
    },
    {
      name: "ui-no-core-by-path",
      severity: "error",
      from: { path: UI },
      to: { path: "^packages/core/" },
    },
    {
      name: "core-imports-no-apps-or-ui",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { path: "^(apps/|packages/(canvas|terminal)/|scripts/)" },
    },
    {
      name: "cli-imports-only-core",
      severity: "error",
      from: { path: "^apps/cli/" },
      to: { path: "^(apps/viewer/|packages/(canvas|terminal)/|scripts/)" },
    },
    {
      name: "canvas-terminal-independent",
      severity: "error",
      from: { path: "^packages/canvas/" },
      to: { path: "^packages/terminal/" },
    },
    {
      name: "terminal-canvas-independent",
      severity: "error",
      from: { path: "^packages/terminal/" },
      to: { path: "^packages/canvas/" },
    },
    {
      name: "nothing-imports-scripts",
      severity: "error",
      from: { pathNot: "^scripts/" },
      to: { path: "^scripts/" },
    },
    {
      name: "viewer-imported-only-by-viewer-scripts-and-storybook",
      severity: "error",
      from: { pathNot: "^(apps/viewer/|packages/storybook/|scripts/)" },
      to: { path: "^apps/viewer/" },
    },
    {
      name: "nothing-imports-storybook",
      severity: "error",
      from: { pathNot: "^packages/storybook/" },
      to: { path: "^packages/storybook/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(^|/)(novnc|dist|target|\\.turbo|storybook-static|\\.ui)(/|$)",
    },
    tsConfig: { fileName: "apps/viewer/tsconfig.json" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
