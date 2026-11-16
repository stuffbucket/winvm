import { expect, it } from "bun:test"

import { fixText, problem, violationsIn } from "./check-comments"

const line = (text: string) => problem("ts", `// ${text}`, false)
const block = (text: string) => problem("ts", `/* ${text} */`, true)

it("allows a reasoned oxlint line directive for one rule", () => {
  expect(
    line(
      "oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Tauri rejects with strings",
    ),
  ).toBeUndefined()
})

it("rejects an oxlint directive without a reason", () => {
  expect(
    line("oxlint-disable-next-line typescript/no-floating-promises"),
  ).toContain("oxlint directive")
  expect(
    line("oxlint-disable-next-line typescript/no-floating-promises --"),
  ).toContain("oxlint directive")
})

it("rejects the file, block, unscoped and multi-rule forms", () => {
  expect(
    line("oxlint-disable typescript/no-floating-promises -- reason"),
  ).toContain("oxlint directive")
  expect(
    block("oxlint-disable typescript/no-floating-promises -- reason"),
  ).toContain("oxlint directive")
  expect(
    block("oxlint-disable-next-line typescript/no-floating-promises -- reason"),
  ).toContain("oxlint directive")
  expect(line("oxlint-disable-next-line -- reason")).toContain(
    "oxlint directive",
  )
  expect(
    line("oxlint-disable-next-line typescript/a, typescript/b -- reason"),
  ).toContain("oxlint directive")
  expect(
    line("oxlint-enable typescript/no-floating-promises -- reason"),
  ).toContain("oxlint directive")
})

it("rejects every eslint directive, even with a reason or a URL", () => {
  expect(line("eslint-disable-next-line no-console")).toContain(
    "eslint directive",
  )
  expect(line("eslint-disable-next-line no-console -- reason")).toContain(
    "eslint directive",
  )
  expect(
    line("eslint-disable-next-line no-console -- see https://example.com/why"),
  ).toContain("eslint directive")
  expect(block("eslint-disable")).toContain("eslint directive")
  expect(block("eslint-enable")).toContain("eslint directive")
  expect(problem("rust", "// eslint-disable-line", false)).toContain(
    "eslint directive",
  )
})

it("still treats prose as prose and keeps the other allowed forms", () => {
  expect(line("just a remark")).toBe("prose comment")
  expect(line("a link https://example.com")).toBeUndefined()
  expect(line("@ts-expect-error the type is wrong")).toBeUndefined()
})

const fixed = (file: string, text: string) => fixText(file, text).text

it("fix drops whole-line comments and keeps code", () => {
  expect(fixed("a.ts", "const a = 1\n// note\nconst b = 2\n")).toBe(
    "const a = 1\nconst b = 2\n",
  )
})

it("fix drops a trailing comment and the whitespace before it", () => {
  expect(fixed("a.ts", "const a = 1 // note\nconst b = 2 /* x */\n")).toBe(
    "const a = 1\nconst b = 2\n",
  )
})

it("fix removes an inline block comment between tokens", () => {
  expect(fixed("a.ts", "call(a, /* why */ b)\n")).toBe("call(a, b)\n")
  expect(fixed("a.ts", "const a/* x */= 1\n")).toBe("const a= 1\n")
  expect(fixed("a.ts", "return/* x */value\n")).toBe("return value\n")
})

it("fix removes multi-line blocks", () => {
  expect(fixed("a.ts", "const a = 1\n/**\n * Doc.\n */\nconst b = 2\n")).toBe(
    "const a = 1\nconst b = 2\n",
  )
  expect(fixed("a.ts", "foo() /* one\ntwo */ bar()\n")).toBe("foo()\nbar()\n")
})

it("fix keeps allowed comments", () => {
  const text = [
    "// @ts-expect-error the type is wrong",
    "const a: number = 'x'",
    "// see https://example.com/spec",
    "/*#__PURE__*/ make()",
    "",
  ].join("\n")
  expect(fixed("a.ts", text)).toBe(text)
})

it("fix leaves comment-like text in strings, templates and regexes", () => {
  const text = [
    'const a = "// not a comment"',
    "const b = '/* nor this */'",
    `const c = \`// \${'x'} /* still text */\``,
    "const d = /\\/\\/ x/",
    "const e = /[/*]/.test('a') // gone",
    "",
  ].join("\n")
  expect(fixed("a.ts", text)).toBe(text.replace(" // gone", ""))
})

it("fix removes a whole JSX comment container", () => {
  const text = [
    "const a = (",
    "  <div>",
    "    {/* heading */}",
    "    <h1>Hi</h1>",
    "    <p>text {/* inline */}</p>",
    "  </div>",
    ")",
    "",
  ].join("\n")
  expect(fixed("a.tsx", text)).toBe(
    [
      "const a = (",
      "  <div>",
      "    <h1>Hi</h1>",
      "    <p>text </p>",
      "  </div>",
      ")",
      "",
    ].join("\n"),
  )
})

it("fix keeps a JSX container whose comment is a directive", () => {
  const text = "const a = <div>{/* @ts-expect-error reason */}</div>\n"
  expect(fixed("a.tsx", text)).toBe(text)
})

it("fix does not read JSX text as a comment", () => {
  const text = "const a = <p>see // this and /* that */</p>\n"
  expect(fixed("a.tsx", text)).toBe(text)
})

it("fix collapses blank lines a removal creates", () => {
  expect(fixed("a.ts", "a()\n\n// x\n\nb()\n")).toBe("a()\n\nb()\n")
  expect(fixed("a.ts", "a()\n// x\n\nb()\n")).toBe("a()\n\nb()\n")
  expect(fixed("a.ts", "a()\n\n// x\n// y\nb()\n")).toBe("a()\n\nb()\n")
  expect(fixed("a.ts", "a()\n// x\nb()\n")).toBe("a()\nb()\n")
})

it("fix leaves blank lines that no removal touched", () => {
  expect(fixed("a.ts", "a()\n\n\n\nb() // x\n")).toBe("a()\n\n\n\nb()\n")
})

it("fix leaves no blank line after an opening brace or before a closing one", () => {
  expect(fixed("a.ts", "function f() {\n  // x\n\n  a()\n\n  // y\n}\n")).toBe(
    "function f() {\n  a()\n}\n",
  )
  expect(fixed("a.ts", "f(\n  // x\n\n  a,\n)\n")).toBe("f(\n  a,\n)\n")
})

it("fix drops leading and trailing comment blocks of a file", () => {
  expect(fixed("a.ts", "// header\n\nconst a = 1\n\n// tail\n")).toBe(
    "const a = 1\n",
  )
  expect(fixed("a.ts", "// only\n")).toBe("")
  expect(fixed("a.ts", "const a = 1 // no newline")).toBe("const a = 1")
})

it("fix handles Rust comment forms", () => {
  const text = [
    "//! crate docs",
    "",
    "/// Does a thing.",
    "pub fn a() {",
    "    // SAFETY: the pointer is valid",
    "    unsafe { go() } // trailing",
    "    /* block */",
    "    /* nested /* inner */ still */",
    "}",
    "",
  ].join("\n")
  expect(fixed("a.rs", text)).toBe(
    [
      "pub fn a() {",
      "    // SAFETY: the pointer is valid",
      "    unsafe { go() }",
      "}",
      "",
    ].join("\n"),
  )
})

it("fix leaves Rust strings, raw strings, chars and lifetimes alone", () => {
  const text = [
    'let a = "// no";',
    'let b = r##"/* no "# still */"##;',
    "let c = '/';",
    "fn f<'a>(x: &'a str) -> &'a str { x } // gone",
    "",
  ].join("\n")
  expect(fixed("a.rs", text)).toBe(text.replace(" // gone", ""))
})

it("fix handles CSS comments", () => {
  expect(
    fixed(
      "a.css",
      '/* head */\n\n.a {\n  /* x */\n  color: red; /* y */\n  background: url("/* z */");\n}\n',
    ),
  ).toBe('.a {\n  color: red;\n  background: url("/* z */");\n}\n')
})

it("fix reaches a state the check accepts and a second fix changes nothing", () => {
  const text = [
    "// a",
    "const x = 1 /* b */ + 2 // c",
    "// @ts-expect-error because",
    "const y: string = x",
    "",
  ].join("\n")
  const once = fixed("a.ts", text)
  expect(once).toBe(
    "const x = 1 + 2\n// @ts-expect-error because\nconst y: string = x\n",
  )
  expect(violationsIn("a.ts", once)).toEqual([])
  expect(fixed("a.ts", once)).toBe(once)
})
