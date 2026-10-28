import assert from "node:assert/strict";
import { test } from "node:test";

import { tableFocus } from "./table-focus.mjs";

const el = (tagName, text = "") => ({ type: "element", tagName, properties: {}, text });
const context = (title) => ({
  data: { astro: { frontmatter: { title } } },
  textContent: (node) => node.text,
  parent: (node) => node.parent,
  setProperty: (node, key, value) => {
    node.properties[key] = value;
  },
});

const run = (nodes, title) => {
  const plugin = tableFocus();
  const ctx = context(title);
  for (const node of nodes) {
    if (plugin.element.filter.includes(node.tagName)) plugin.element.visit(node, ctx);
  }
};

test("each table can take focus and is named by the heading above it", () => {
  const first = el("table");
  const second = el("table");
  run([el("h2", "Matrix: models by corpora"), first, el("h3", "Receipt"), second], "Evaluation");
  assert.deepEqual(first.properties, { tabIndex: 0, ariaLabel: "Matrix: models by corpora" });
  assert.deepEqual(second.properties, { tabIndex: 0, ariaLabel: "Receipt" });
});

test("a table before any heading is named by the page title", () => {
  const table = el("table");
  run([table], "Models");
  assert.equal(table.properties.ariaLabel, "Models");
});

test("each page starts without a heading", () => {
  run([el("h2", "Earlier page")], "One");
  const table = el("table");
  run([table], "Two");
  assert.equal(table.properties.ariaLabel, "Two");
});

test("each cell is labelled with its column heading, table by table", () => {
  const cells = [el("td", "16"), el("td", "32"), el("td", "x")];
  run(
    [
      el("table"),
      el("tr"),
      el("th", "Words"),
      el("th", " Tokens "),
      el("th", "Answer"),
      el("tr"),
      cells[0],
      cells[1],
      el("table"),
      el("tr"),
      el("th", ""),
      el("th", "B"),
      el("th", "C"),
      el("tr"),
      cells[2],
    ],
    "How it works",
  );
  assert.equal(cells[0].properties.dataLabel, "Words");
  assert.equal(cells[1].properties.dataLabel, "Tokens");
  assert.equal(cells[2].properties.dataLabel, undefined);
});

test("a table of two columns keeps its cells unlabelled, so it stays a table on a narrow screen", () => {
  const cell = el("td", "x");
  run([el("table"), el("tr"), el("th", "Field"), el("th", "Value"), el("tr"), cell], "Evaluation");
  assert.equal(cell.properties.dataLabel, undefined);
});

test("only long code in a cell may break: a hash, not a model name or code outside tables", () => {
  const within = (parent, child) => Object.assign(child, { parent });
  const hash = within(el("td"), el("code", "2912a88ced21226182122"));
  const linked = within(within(el("td"), el("a")), el("code", "9c4e62659eefa3976d022d90"));
  const name = within(el("td"), el("code", "nineteen-characters"));
  const spaced = within(el("td"), el("code", "a b c d e f g h i j k l"));
  const outside = within(el("p"), el("code", "a-very-long-name-outside-a-table"));
  run([el("table"), el("tr"), hash, linked, name, spaced, outside], "Evaluation");
  assert.equal(hash.properties.dataBreak, "");
  assert.equal(linked.properties.dataBreak, "");
  assert.equal(name.properties.dataBreak, undefined);
  assert.equal(spaced.properties.dataBreak, undefined);
  assert.equal(outside.properties.dataBreak, undefined);
});
