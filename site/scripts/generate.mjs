// Writes the site's pages from the repository's own Markdown, so the site always shows what README.md and docs/
// say. Run before `astro build` / `astro dev`; everything it writes is git-ignored.
//
//   README.md        -> src/content/docs/index.md      -> /winvm/
//   docs/<name>.md   -> src/content/docs/<name>.md     -> /winvm/<name>/
//   apps/viewer/src-tauri/icons/32x32.png -> public/favicon.png
//
// docs/ subdirectories (docs/superpowers/) are not published. Each page's first `# ` heading becomes its title.
// Relative links are rewritten: a link to another published doc goes to its page, a link to README.md goes to the
// home page, and a link to any other file in the repository goes to that file on GitHub.
//
// It also checks the links it rewrites and prints a warning for a link to a file that does not exist or to a
// heading that is not in the target page. Set SITE_STRICT_LINKS=1 to make those warnings fail the build.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import GithubSlugger from "github-slugger";

export const REPO_URL = "https://github.com/stuffbucket/winvm";
export const BASE = "/winvm";
const BRANCH = "main";
const ICON = "apps/viewer/src-tauri/icons/32x32.png";

/** Docs that go in the sidebar's last group, for people who maintain winvm rather than use it. */
export const MAINTAINER_DOCS = ["release-runbook"];

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCE = /^\s*(```|~~~)/;

/** The names (without .md) of the published docs: the Markdown files directly in docs/. */
export function docNames(root) {
  const dir = join(root, "docs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name.replace(/\.md$/, ""));
}

/**
 * The docs in sidebar order: the order README.md first links them in, then any it does not link, by name.
 * Maintainer docs are left out (the sidebar lists them separately).
 */
export function docOrder(root) {
  const names = docNames(root).filter((n) => !MAINTAINER_DOCS.includes(n));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const linked = [];
  for (const m of readme.matchAll(/\]\((?:\.\/)?docs\/([^/)#\s]+)\.md[#)]/g)) {
    if (names.includes(m[1]) && !linked.includes(m[1])) linked.push(m[1]);
  }
  return [...linked, ...names.filter((n) => !linked.includes(n)).sort()];
}

/** The heading anchors GitHub (and Astro) give a Markdown file's headings. */
export function anchorsOf(markdown) {
  const slugger = new GithubSlugger();
  const anchors = new Set();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) anchors.add(slugger.slug(plainText(m[1])));
  }
  return anchors;
}

/** Heading text as it reads: no backticks, emphasis, or link syntax. */
export function plainText(s) {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .trim();
}

/**
 * Rewrites one link target from a Markdown file at `sourceDir` (relative to the repository root) so it works on
 * the site. Reports a broken link through `ctx.problems`.
 */
export function rewriteTarget(target, { root, docs, anchors, sourceDir, source, problems, image = false }) {
  if (target === "" || target.startsWith("/") || SCHEME.test(target)) return target;
  if (target.startsWith("#")) {
    const own = anchors.get(source);
    if (own && !own.has(decodeURIComponent(target.slice(1)))) problems.push(`${source}: no heading for ${target}`);
    return target;
  }
  const hashAt = target.indexOf("#");
  const path = hashAt < 0 ? target : target.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : target.slice(hashAt);
  const resolved = posix.normalize(posix.join(sourceDir, path));
  if (resolved.startsWith("..")) {
    problems.push(`${source}: ${target} points outside the repository`);
    return target;
  }
  const page = resolved === "README.md" ? "README.md" : docs.has(resolved) ? resolved : null;
  if (page) {
    if (hash && !anchors.get(page)?.has(decodeURIComponent(hash.slice(1)))) {
      problems.push(`${source}: ${target} (no heading ${hash} in ${page})`);
    }
    return `${BASE}/${pageSlug(page)}${hash}`;
  }
  const abs = join(root, resolved);
  if (!existsSync(abs)) problems.push(`${source}: ${target} (no such file: ${resolved})`);
  const isDir = existsSync(abs) && statSync(abs).isDirectory();
  const clean = resolved.replace(/\/$/, "");
  if (image) return `https://raw.githubusercontent.com/stuffbucket/winvm/${BRANCH}/${clean}`;
  return `${REPO_URL}/${isDir ? "tree" : "blob"}/${BRANCH}/${clean}${hash}`;
}

/** The site path (after the base) of a published Markdown file: "" for README.md, "<name>/" for docs/<name>.md. */
export function pageSlug(repoPath) {
  if (repoPath === "README.md") return "";
  return `${repoPath.replace(/^docs\//, "").replace(/\.md$/, "")}/`;
}

/** Rewrites the inline and reference-style link targets outside code fences. */
export function rewriteLinks(markdown, ctx) {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const inline = line.replace(
        /(!?)(\]\()([^)\s]*)((?:\s+"[^"]*")?\))/g,
        (_, bang, a, target, c) => `${bang}${a}${rewriteTarget(target, { ...ctx, image: bang === "!" })}${c}`,
      );
      return inline.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/, (_, a, target) => `${a}${rewriteTarget(target, ctx)}`);
    })
    .join("\n");
}

const yamlString = (s) => JSON.stringify(s);

function page({ title, editPath, body, extra = {} }) {
  const fields = { title: yamlString(title), editUrl: yamlString(`${REPO_URL}/edit/${BRANCH}/${editPath}`), ...extra };
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

/** Splits off the first `# ` heading: its plain text is the page title, the rest is the body. */
export function splitTitle(source, fallback) {
  let fenced = false;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const m = lines[i].match(/^#\s+(.+?)\s*$/);
    if (m) {
      const body = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").replace(/^\s*\n/, "");
      return { title: plainText(m[1]), body };
    }
  }
  return { title: fallback, body: source };
}

export function generate(root, outDir) {
  const names = docNames(root);
  const sources = new Map([["README.md", readFileSync(join(root, "README.md"), "utf8")]]);
  for (const n of names) sources.set(`docs/${n}.md`, readFileSync(join(root, "docs", `${n}.md`), "utf8"));
  const docs = new Set([...sources.keys()].filter((k) => k !== "README.md"));
  const anchors = new Map([...sources].map(([k, v]) => [k, anchorsOf(v)]));
  const problems = [];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [repoPath, source] of sources) {
    const isReadme = repoPath === "README.md";
    const { title, body } = splitTitle(source, isReadme ? "winvm" : repoPath);
    const ctx = { root, docs, anchors, sourceDir: posix.dirname(repoPath), source: repoPath, problems };
    const text = page({
      title,
      editPath: repoPath,
      body: rewriteLinks(body, ctx),
    });
    const file = join(outDir, isReadme ? "index.md" : `${repoPath.replace(/^docs\//, "")}`);
    writeFileSync(file, text);
  }
  return { pages: sources.size, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../..");
  const site = resolve(here, "..");
  const { pages, problems } = generate(root, join(site, "src/content/docs"));
  mkdirSync(join(site, "public"), { recursive: true });
  copyFileSync(join(root, ICON), join(site, "public/favicon.png"));
  console.log(`generated ${pages} pages from README.md and docs/`);
  for (const p of problems) console.warn(`warning: broken link in ${p}`);
  if (problems.length && process.env.SITE_STRICT_LINKS === "1") {
    console.error(`${problems.length} broken link(s); SITE_STRICT_LINKS=1 makes them fatal`);
    process.exit(1);
  }
}
