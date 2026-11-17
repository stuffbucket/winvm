const PLAIN = new Set(["", "plaintext", "text", "txt", "plain"])

export const TABINDEX_SCRIPT_MARKER = "tabindex-js-module"

export function codeName({ title, language }) {
  const trimmed = title?.trim()
  if (trimmed) return trimmed
  const lang = language?.trim().toLowerCase() ?? ""
  return PLAIN.has(lang) ? "Code" : `Code: ${lang}`
}

function findElement(node, tagName) {
  if (node?.type === "element" && node.tagName === tagName) return node
  for (const child of node?.children ?? []) {
    const found = findElement(child, tagName)
    if (found) return found
  }
  return null
}

function makeFocusable(blockAst, codeBlock) {
  const pre = findElement(blockAst, "pre")
  if (!pre) return
  pre.properties ??= {}
  pre.properties.tabIndex = 0
  pre.properties.role = "group"
  pre.properties.ariaLabel = codeName({
    title: codeBlock.props?.title,
    language: codeBlock.language,
  })
}

export function withoutTabindexScript(createRenderer) {
  return async (options) => {
    const renderer = await createRenderer(options)
    const kept = renderer.jsModules.filter(
      (code) => !code.includes(TABINDEX_SCRIPT_MARKER),
    )
    if (kept.length === renderer.jsModules.length) {
      options?.logger?.warn?.(
        "code-focus: Expressive Code's tabindex script was not found; it may undo code block focus",
      )
    }
    renderer.jsModules = kept
    return renderer
  }
}

export default function codeFocus() {
  return {
    name: "code-focus",
    hooks: {
      postprocessRenderedBlock: ({ codeBlock, renderData }) =>
        makeFocusable(renderData.blockAst, codeBlock),
    },
  }
}
