import assert from "node:assert/strict";
import { test } from "node:test";

import { createRenderer } from "@astrojs/starlight/expressive-code";

import codeFocus, { codeName, TABINDEX_SCRIPT_MARKER, withoutTabindexScript } from "./code-focus.mjs";

const el = (tagName, children = [], properties = {}) => ({ type: "element", tagName, properties, children });

// The shape Expressive Code renders: a figure with a caption, then pre > code.
const block = () =>
  el("figure", [el("figcaption", [el("span")]), el("pre", [el("code")], { dataLanguage: "sh" })], {
    className: ["frame"],
  });

const run = (blockAst, codeBlock) => {
  codeFocus().hooks.postprocessRenderedBlock({ codeBlock, renderData: { blockAst } });
  return blockAst.children[1].properties;
};

test("the pre can take focus and is a named group", () => {
  const props = run(block(), { language: "sh", props: {} });
  assert.deepEqual(props, { dataLanguage: "sh", tabIndex: 0, role: "group", ariaLabel: "Code: sh" });
});

test("a frame title names the block", () => {
  const props = run(block(), { language: "js", props: { title: "  src/index.js " } });
  assert.equal(props.ariaLabel, "src/index.js");
});

test("plain text is just Code", () => {
  assert.equal(codeName({ language: "text" }), "Code");
  assert.equal(codeName({ language: "plaintext" }), "Code");
  assert.equal(codeName({}), "Code");
  assert.equal(codeName({ title: " ", language: "JSON" }), "Code: json");
});

test("a block without a pre is left alone", () => {
  const ast = el("figure", [el("div")]);
  codeFocus().hooks.postprocessRenderedBlock({ codeBlock: { language: "sh", props: {} }, renderData: { blockAst: ast } });
  assert.deepEqual(ast.children[0].properties, {});
});

test("the tabindex script is dropped and the others kept", async () => {
  const warnings = [];
  const create = withoutTabindexScript(async () => ({ jsModules: ["copy()", `/* ${TABINDEX_SCRIPT_MARKER} */`] }));
  const renderer = await create({ logger: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(renderer.jsModules, ["copy()"]);
  assert.deepEqual(warnings, []);
});

test("a warning when there is no tabindex script to drop", async () => {
  const warnings = [];
  const create = withoutTabindexScript(async () => ({ jsModules: ["copy()"] }));
  await create({ logger: { warn: (m) => warnings.push(m) } });
  assert.equal(warnings.length, 1);
});

test("the installed Expressive Code still ships the script this drops", async () => {
  const renderer = await createRenderer({ themes: ["github-dark"] });
  assert.ok(renderer.jsModules.some((code) => code.includes(TABINDEX_SCRIPT_MARKER)));
});
