const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
const CELLS = new Set(["td", "th"]);

const STACK_COLUMNS = 3;

const LONG_CODE = 20;

export function tableFocus() {
  let heading = null;
  let labels = [];
  let column = 0;
  return {
    name: "table-focus",
    element: {
      filter: [...HEADINGS, "table", "tr", "th", "td", "code"],
      visit(node, ctx) {
        switch (node.tagName) {
          case "table": {
            const title = ctx.data?.astro?.frontmatter?.title;
            ctx.setProperty(node, "tabIndex", 0);
            ctx.setProperty(node, "ariaLabel", heading ?? title ?? "Table");
            labels = [];
            return;
          }
          case "tr":
            column = 0;
            return;
          case "th":
            labels[column++] = ctx.textContent(node).trim();
            return;
          case "td": {
            const label = labels[column++];
            if (label && labels.length >= STACK_COLUMNS) ctx.setProperty(node, "dataLabel", label);
            return;
          }
          case "code": {
            const parent = ctx.parent(node);
            const cell = CELLS.has(parent?.tagName) ? parent : parent && ctx.parent(parent);
            if (!CELLS.has(cell?.tagName)) return;
            const text = ctx.textContent(node);
            if (text.length >= LONG_CODE && !/\s/.test(text)) ctx.setProperty(node, "dataBreak", "");
            return;
          }
          default:
            heading = ctx.textContent(node).trim() || heading;
        }
      },
    },
  };
}

export default function tableFocusIntegration() {
  return {
    name: "table-focus",
    hooks: {
      "astro:config:setup": ({ config, logger }) => {
        const plugins = config.markdown.processor?.options?.hastPlugins;
        if (!Array.isArray(plugins)) {
          logger.warn("the Markdown processor takes no hast plugins; tables will not be focusable");
          return;
        }
        plugins.push(tableFocus);
      },
    },
  };
}
