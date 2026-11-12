// Fails when a tracked Markdown file links to a relative path that does not exist, names a
// `#anchor` the target Markdown file does not have, when an AGENTS.md outgrows its line budget, or
// when a backticked path in an AGENTS.md `## Map` section or on an ADR `- Code:` line is gone.
// Web links and links inside code are not checked.
//
//   node scripts/check-docs.mts [--root <dir>] [--root-budget <lines>] [--nested-budget <lines>]
//
// Budgets default to 300 lines for the root AGENTS.md and 150 for a nested one. A
// `docs-budget.json` next to this script ({ "root": 300, "nested": 150 }) changes the defaults;
// the flags win over the file.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

type DocProblem = { file: string; line: number; message: string };
type DocsBudget = { root: number; nested: number };

const DEFAULT_BUDGET: DocsBudget = { root: 300, nested: 150 };
const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;
const ATX_HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/;
const HTML_ANCHOR = /<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FILE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|json[c5]?|mdx?|ya?ml|toml|css|scss|html?|sql|sh|py|go|rs|prisma|graphql|gql|grit|lock|txt)$/i;

/** The anchor GitHub gives a heading: lower case, punctuation dropped, one hyphen per space. */
function slugHeading(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replaceAll(" ", "-");
}

/** The file's lines with front matter, fenced code and HTML comments blanked, so line numbers stay true. */
function proseLines(text: string): string[] {
  const lines = text.split("\n");
  let fence: string | null = null;
  let inComment = false;
  let inFrontMatter = lines[0]?.trim() === "---";
  return lines.map((line, index) => {
    if (inFrontMatter) {
      if (index > 0 && line.trim() === "---") inFrontMatter = false;
      return "";
    }
    const marker = inComment ? undefined : /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null;
      return "";
    }
    if (fence !== null) return "";
    let visible = "";
    let rest = line;
    while (rest !== "") {
      const token = inComment ? "-->" : "<!--";
      const at = rest.indexOf(token);
      if (at === -1) {
        if (!inComment) visible += rest;
        break;
      }
      if (!inComment) visible += rest.slice(0, at);
      rest = rest.slice(at + token.length);
      inComment = !inComment;
    }
    return visible;
  });
}

function collectAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const add = (heading: string) => {
    const slug = slugHeading(heading);
    const count = seen.get(slug) ?? 0;
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    seen.set(slug, count + 1);
  };
  const lines = proseLines(text);
  for (const [index, line] of lines.entries()) {
    const atx = ATX_HEADING.exec(line);
    const next = lines[index + 1];
    if (atx) add(atx[1] ?? "");
    else if (
      next !== undefined &&
      line.trim() !== "" &&
      SETEXT_UNDERLINE.test(next) &&
      !/^\s*([-*+]|\d+\.)\s/.test(line)
    )
      add(line);
  }
  for (const [, id] of text.matchAll(HTML_ANCHOR)) if (id) anchors.add(id);
  return anchors;
}

function linkTargets(line: string): string[] {
  const code = line.replace(INLINE_CODE, "");
  const targets = [...code.matchAll(INLINE_LINK)].map((match) => match[1] ?? "");
  const definition = REFERENCE_DEFINITION.exec(code)?.[1];
  if (definition) targets.push(definition);
  return targets.map((target) => target.replace(/^<|>$/g, "")).filter((target) => target !== "");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function findLinkProblems(root: string, files: string[]): DocProblem[] {
  const problems: DocProblem[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (path: string) => {
    let anchors = anchorCache.get(path);
    if (!anchors) {
      anchors = collectAnchors(readFileSync(path, "utf8"));
      anchorCache.set(path, anchors);
    }
    return anchors;
  };

  for (const file of files) {
    const source = join(root, file);
    proseLines(readFileSync(source, "utf8")).forEach((line, index) => {
      for (const target of linkTargets(line)) {
        if (URL_SCHEME.test(target)) continue;
        const hashAt = target.indexOf("#");
        const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
        const anchor = hashAt === -1 ? "" : target.slice(hashAt + 1);
        const cleanPath = decode(pathPart.split("?")[0] ?? "");
        const resolved =
          cleanPath === ""
            ? source
            : normalize(cleanPath.startsWith("/") ? join(root, cleanPath) : join(dirname(source), cleanPath));
        const shown = relative(root, resolved);
        const report = (message: string) => problems.push({ file, line: index + 1, message: `${target} ${message}` });

        if (shown === ".." || shown.startsWith(`..${sep}`)) report("points outside the repository");
        else if (!existsSync(resolved)) report(`names ${shown}, which does not exist`);
        else if (anchor !== "" && resolved.endsWith(".md") && !anchorsOf(resolved).has(decode(anchor).toLowerCase())) {
          report(`names #${anchor}, which ${shown} does not have`);
        }
      }
    });
  }
  return problems;
}

/**
 * Backticked tokens that read as repository paths: a slash, or a file extension, so `db.query` and
 * `chargeCard` stay names. Globs, calls, package names, flags and URLs are skipped; `:line` is dropped.
 */
function codePaths(line: string): string[] {
  return [...line.matchAll(/`([^`\s]+)`/g)]
    .map((match) => (match[1] ?? "").replace(/:\d+(?::\d+)?$/, ""))
    .filter((token) => token.includes("/") || FILE_EXTENSION.test(token))
    .filter((token) => !/[*?(){}<>]|^[@-]/.test(token) && !URL_SCHEME.test(token));
}

/** Lines of the `## Map` section, up to the next heading of level 1 or 2. */
function mapLines(lines: string[]): { line: string; index: number }[] {
  const start = lines.findIndex((line) => /^\s{0,3}##\s+Map\s*#*\s*$/.test(line));
  if (start === -1) return [];
  const section: { line: string; index: number }[] = [];
  for (let index = start + 1; index < lines.length && !/^\s{0,3}#{1,2}\s/.test(lines[index] ?? ""); index += 1)
    section.push({ line: lines[index] ?? "", index });
  return section;
}

/**
 * Paths an agent is told to open: the `## Map` of each AGENTS.md (resolved from its folder or the
 * repository root) and the `- Code:` line of each ADR under an `adr/` folder.
 */
function findCodePathProblems(root: string, files: string[]): DocProblem[] {
  const problems: DocProblem[] = [];
  for (const file of files) {
    const isAgents = basename(file) === "AGENTS.md";
    const isAdr = /(^|\/)adr\/[^/]+\.md$/.test(file);
    if (!isAgents && !isAdr) continue;
    const lines = proseLines(readFileSync(join(root, file), "utf8"));
    const checked = isAgents
      ? mapLines(lines)
      : lines.flatMap((line, index) => (/^\s*[-*]\s+Code:/.test(line) ? [{ line, index }] : []));
    const where = isAgents ? "the map" : "the Code line";
    for (const { line, index } of checked) {
      for (const path of codePaths(line)) {
        const candidates = [join(root, dirname(file), path), join(root, path)];
        if (!candidates.some((candidate) => existsSync(candidate)))
          problems.push({ file, line: index + 1, message: `${where} names ${path}, which does not exist` });
      }
    }
  }
  return problems;
}

function findBudgetProblems(root: string, files: string[], budget: DocsBudget): DocProblem[] {
  const problems: DocProblem[] = [];
  for (const file of files) {
    if (basename(file) !== "AGENTS.md") continue;
    const isRoot = file === "AGENTS.md";
    const limit = isRoot ? budget.root : budget.nested;
    const text = readFileSync(join(root, file), "utf8");
    const count = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (count > limit) {
      const which = isRoot ? "the root AGENTS.md" : "a nested AGENTS.md";
      problems.push({ file, line: limit + 1, message: `has ${count} lines; the budget for ${which} is ${limit}` });
    }
  }
  return problems;
}

function trackedMarkdown(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(root, file)));
}

export function checkDocs(root: string, options: { files?: string[]; budget?: DocsBudget } = {}): DocProblem[] {
  const files = options.files ?? trackedMarkdown(root);
  return [
    ...findLinkProblems(root, files),
    ...findCodePathProblems(root, files),
    ...findBudgetProblems(root, files, options.budget ?? DEFAULT_BUDGET),
  ];
}

function readBudgetFile(): Partial<DocsBudget> {
  const path = join(import.meta.dirname, "docs-budget.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function parseLimit(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`${flag} needs a positive whole number, got "${value}"`);
  return limit;
}

function main(): void {
  const { values } = parseArgs({
    options: { root: { type: "string" }, "root-budget": { type: "string" }, "nested-budget": { type: "string" } },
  });
  const root = resolve(values.root ?? process.cwd());
  const fromFile = readBudgetFile();
  const budget: DocsBudget = {
    root: parseLimit("--root-budget", values["root-budget"]) ?? fromFile.root ?? DEFAULT_BUDGET.root,
    nested: parseLimit("--nested-budget", values["nested-budget"]) ?? fromFile.nested ?? DEFAULT_BUDGET.nested,
  };
  const files = trackedMarkdown(root);
  const problems = checkDocs(root, { files, budget });
  if (problems.length > 0) {
    console.error(
      ["Docs need fixing:", ...problems.map((problem) => `  ${problem.file}:${problem.line}: ${problem.message}`)].join(
        "\n",
      ),
    );
    process.exitCode = 1;
  } else {
    console.log(`Checked links, map and ADR paths in ${files.length} Markdown files, and the AGENTS.md budgets.`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) main();
