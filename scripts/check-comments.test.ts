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

const ps = (text: string) => problem("powershell", text, false)
const psBlock = (text: string) => problem("powershell", text, true)
const cs = (text: string) => problem("csharp", text, false)
const csBlock = (text: string) => problem("csharp", text, true)

it("treats PowerShell prose, help blocks and regions as prose", () => {
  expect(ps("# just a remark")).toBe("prose comment")
  expect(ps("#region Helpers")).toBe("prose comment")
  expect(psBlock("<# .SYNOPSIS Does a thing. #>")).toBe("prose comment")
})

it("keeps PowerShell directives and URLs", () => {
  expect(ps("#Requires -Version 5.1")).toBeUndefined()
  expect(ps("#requires -RunAsAdministrator")).toBeUndefined()
  expect(ps("#!/usr/bin/env pwsh")).toBeUndefined()
  expect(ps("# see https://example.com/spec")).toBeUndefined()
  expect(ps("#RequiresNothing")).toBe("prose comment")
})

it("treats C# prose and doc comments as prose, keeps directives and URLs", () => {
  expect(cs("// just a remark")).toBe("prose comment")
  expect(cs("/// <summary>Does a thing.</summary>")).toBe("prose comment")
  expect(csBlock("/* a remark */")).toBe("prose comment")
  expect(cs("// <auto-generated>")).toBeUndefined()
  expect(csBlock("/* <auto-generated> */")).toBeUndefined()
  expect(cs("// see https://example.com/spec")).toBeUndefined()
})

it("fix removes PowerShell line and block comments", () => {
  const text = [
    "#Requires -Version 5.1",
    "# note",
    "$a = 1 # trailing",
    "<# help",
    ".SYNOPSIS",
    "#>",
    "$b = 2 <# inline #> + 3",
    "",
  ].join("\n")
  expect(fixed("a.ps1", text)).toBe(
    "#Requires -Version 5.1\n$a = 1\n$b = 2 + 3\n",
  )
})

it("fix leaves PowerShell strings, here-strings and variables alone", () => {
  const text = [
    "$a = 'it''s # not a comment'",
    '$b = "# nor `" this $(Get-X "# or this") ok"',
    '$c = "a""# b"',
    "$d = @'",
    "# inside a single-quoted here-string",
    "// and <# this #>",
    "'@",
    '$e = @"',
    "# inside $a a double-quoted here-string",
    '"@',
    `\${#} = \${env:ProgramFiles(x86)} + $#x`,
    "if ($s -match '^#\\d+') { $n = ($s -replace '#', '') }",
    "Write-Output foo#bar `# escaped",
    "$f = ‘# smart’ + “# smart”",
    "$g = 1 # gone",
    "",
  ].join("\n")
  expect(fixed("a.ps1", text)).toBe(text.replace(" # gone", ""))
})

it("fix handles comments after PowerShell script block delimiters", () => {
  expect(fixed("a.ps1", "if ($a) { # open\n  b # x\n}# close\n")).toBe(
    "if ($a) {\n  b\n}\n",
  )
})

it("fix keeps a PowerShell signature block intact", () => {
  const text = [
    "$a = 1",
    "# SIG # Begin signature block",
    "# MIIabc==",
    "# SIG # End signature block",
    "",
  ].join("\n")
  expect(fixed("a.ps1", text)).toBe(text)
  expect(violationsIn("a.ps1", text)).toEqual([])
})

it("fix removes C# line, doc and block comments", () => {
  const text = [
    "// <auto-generated>",
    "// header",
    "using System;",
    "/// <summary>Doc.</summary>",
    "class A {",
    "  /** javadoc style */",
    "  int x = 9 /* NAME */; // trailing",
    "  int y = f(1 /* a */, /* b */ 2);",
    "}",
    "",
  ].join("\n")
  expect(fixed("a.cs", text)).toBe(
    [
      "// <auto-generated>",
      "using System;",
      "class A {",
      "  int x = 9;",
      "  int y = f(1, 2);",
      "}",
      "",
    ].join("\n"),
  )
})

it("fix leaves C# strings and char literals alone", () => {
  const text = [
    'var a = "// not /* a */ comment";',
    'var b = "esc \\" // still string";',
    'var c = @"verbatim // \\ ""quoted"" /* x */";',
    'var d = @"multi',
    '// line "" /* x */";',
    "var e = '/'; var f = '\\''; var g = '\"'; var h = '\\\\';",
    'var i = $"interp // {x} {{ /* y */ }}";',
    'var j = $"hole {Fn("// a") + "/* b */"} // tail";',
    'var k = $@"both // {x} ""q"" /* z */";',
    'var l = @$"swapped // {x}";',
    'var m = """raw // "quoted" /* x */""";',
    'var n = $"""raw {x} // "y" """;',
    'var o = """"four """ // still raw"""";',
    'var p = ""; var q = "x"; // gone',
    "",
  ].join("\n")
  expect(fixed("a.cs", text)).toBe(text.replace(" // gone", ""))
})

it("fix leaves C# preprocessor directives alone and drops their comments", () => {
  const text = [
    "#if DEBUG // gone",
    "#pragma warning disable 0168",
    "#region Don't parse this as a char",
    "int a;",
    "#endregion",
    "#endif",
    "",
  ].join("\n")
  expect(fixed("a.cs", text)).toBe(text.replace(" // gone", ""))
})

it("fix on PowerShell and C# reaches a fixed point the check accepts", () => {
  const psText = "# a\n$x = 1 # b\n#Requires -Version 5.1\n"
  const csText = "// a\nint x = 1; /* b */\n"
  for (const [file, text] of [
    ["a.ps1", psText],
    ["a.cs", csText],
  ] as const) {
    const once = fixed(file, text)
    expect(violationsIn(file, once)).toEqual([])
    expect(fixed(file, once)).toBe(once)
  }
})
