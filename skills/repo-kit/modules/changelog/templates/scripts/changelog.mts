// Release notes live in one `changelog.d/<branch>.md` file per pull request, so two pull requests
// never edit the same lines of CHANGELOG.md. See changelog.d/README.md for the fragment format.
//
//   node scripts/changelog.mts check                          validate every fragment
//   node scripts/changelog.mts check --base <rev> [--labels <json array | a,b>] [--branch <name>]
//                                                            also require this change to add notes,
//                                                            unless it has the no-changelog label
//   node scripts/changelog.mts release <version> [--date YYYY-MM-DD]
//                                                            fold every fragment into CHANGELOG.md

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const GROUPS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const;
type Group = (typeof GROUPS)[number];

const FRAGMENT_DIR = "changelog.d";
const SKIP_LABEL = "no-changelog";
const CHANGELOG = "CHANGELOG.md";
const HEADER = "# Changelog\n\nAll notable changes to this project are listed here, newest first.\n";

type ParsedFragment = { entries: Map<Group, string[]>; problems: { line: number; message: string }[] };

function isGroup(name: string): name is Group {
  return (GROUPS as readonly string[]).includes(name);
}

function parseFragment(text: string): ParsedFragment {
  const entries = new Map<Group, string[]>();
  const problems: ParsedFragment["problems"] = [];
  // "rejected" follows a heading that is already reported, so its bullets add no second problem.
  let group: Group | "rejected" | null = null;
  let groupLine = 0;
  let bulletLines = 0;
  let bullets: string[] = [];

  const closeGroup = () => {
    if (group !== null && group !== "rejected") {
      if (bulletLines === 0) problems.push({ line: groupLine, message: `### ${group} has no bullets` });
      if (bullets.length > 0) entries.set(group, [...(entries.get(group) ?? []), ...bullets]);
    }
    group = null;
    bulletLines = 0;
    bullets = [];
  };

  text.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "") return;
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (heading) {
      closeGroup();
      const name = heading[1] ?? "";
      groupLine = lineNumber;
      if (line.startsWith("### ") && isGroup(name)) {
        group = name;
      } else {
        group = "rejected";
        problems.push({
          line: lineNumber,
          message: `"${line.trim()}" is not a group; use one of ${GROUPS.join(", ")}`,
        });
      }
      return;
    }
    const bullet = /^[-*](?:\s+(.*))?$/.exec(line);
    if (bullet) {
      const note = (bullet[1] ?? "").trim();
      bulletLines += 1;
      if (group === null) problems.push({ line: lineNumber, message: "a bullet needs a group heading above it" });
      else if (note === "") problems.push({ line: lineNumber, message: "empty bullet" });
      else if (group !== "rejected") bullets.push(`- ${note}`);
      return;
    }
    if (group === "rejected") return;
    const last = bullets.at(-1);
    if (/^\s+\S/.test(line) && last !== undefined) {
      bullets[bullets.length - 1] = `${last}\n  ${line.trim()}`;
      return;
    }
    problems.push({ line: lineNumber, message: "write each note as a bullet (- ...) under a group heading" });
  });
  closeGroup();
  if (entries.size === 0 && problems.length === 0) problems.push({ line: 1, message: "the fragment has no notes" });
  return { entries, problems };
}

function fragmentPaths(root: string): string[] {
  const dir = join(root, FRAGMENT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => `${FRAGMENT_DIR}/${name}`);
}

function readFragments(root: string): { path: string; parsed: ParsedFragment }[] {
  return fragmentPaths(root).map((path) => ({ path, parsed: parseFragment(readFileSync(join(root, path), "utf8")) }));
}

/** Problems in every fragment, as `path:line: message`. */
export function checkFragments(root: string): string[] {
  return readFragments(root).flatMap(({ path, parsed }) =>
    parsed.problems.map((problem) => `${path}:${problem.line}: ${problem.message}`),
  );
}

/** Why the pull request still needs release notes, or null when it has them or opts out. */
export function checkPullRequest(input: { changedFiles: string[]; labels: string[]; branch?: string }): string | null {
  if (input.labels.includes(SKIP_LABEL)) return null;
  const hasNotes = input.changedFiles.some(
    (file) =>
      file === CHANGELOG ||
      (file.startsWith(`${FRAGMENT_DIR}/`) && file.endsWith(".md") && file !== `${FRAGMENT_DIR}/README.md`),
  );
  if (hasNotes) return null;
  const name = input.branch ? input.branch.replaceAll("/", "-") : "<branch>";
  return `Write the release notes in ${FRAGMENT_DIR}/${name}.md (see ${FRAGMENT_DIR}/README.md), or add the ${SKIP_LABEL} label when no user sees a change.`;
}

function renderSection(version: string, date: string, entries: Map<Group, string[]>): string {
  const groups = GROUPS.filter((group) => entries.has(group)).map(
    (group) => `### ${group}\n\n${(entries.get(group) ?? []).join("\n")}\n`,
  );
  return `## [${version}] - ${date}\n\n${groups.join("\n")}`;
}

function insertSection(changelog: string, section: string): string {
  const text = changelog.trim() === "" ? HEADER : changelog.endsWith("\n") ? changelog : `${changelog}\n`;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^## \[/.test(line) && !/^## \[unreleased\]/i.test(line));
  if (at === -1) return `${text.replace(/\n+$/, "")}\n\n${section}`;
  return [...lines.slice(0, at), ...section.split("\n"), ...lines.slice(at)].join("\n");
}

/** Moves every fragment into a new CHANGELOG.md section and deletes the fragments it moved. */
export function releaseChangelog(root: string, version: string, date: string): { folded: string[] } {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`"${version}" is not a version like 1.2.3`);
  const fragments = readFragments(root);
  if (fragments.length === 0) throw new Error(`no release notes in ${FRAGMENT_DIR}: nothing to release`);
  const problems = checkFragments(root);
  if (problems.length > 0) throw new Error(`fix the release notes first:\n${problems.join("\n")}`);

  const changelogPath = join(root, CHANGELOG);
  const current = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const escaped = version.replace(/[.+]/g, "\\$&");
  if (new RegExp(`^## \\[${escaped}\\]`, "m").test(current)) throw new Error(`${CHANGELOG} already has ${version}`);

  const merged = new Map<Group, string[]>();
  for (const { parsed } of fragments) {
    for (const [group, bullets] of parsed.entries) merged.set(group, [...(merged.get(group) ?? []), ...bullets]);
  }
  writeFileSync(changelogPath, insertSection(current, renderSection(version, date, merged)));
  for (const { path } of fragments) rmSync(join(root, path));
  return { folded: fragments.map(({ path }) => path) };
}

function parseLabels(value: string | undefined): string[] {
  if (!value) return [];
  if (value.trim().startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === "string") : [];
  }
  return value.split(",").map((label) => label.trim());
}

function changedFiles(root: string, base: string): string[] {
  return execFileSync("git", ["diff", "--name-only", "-z", "--diff-filter=ACMR", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "");
}

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      base: { type: "string" },
      labels: { type: "string" },
      branch: { type: "string" },
      date: { type: "string" },
    },
  });
  const root = resolve(values.root ?? process.cwd());
  const [command, version] = positionals;

  if (command === "check") {
    const problems = checkFragments(root);
    if (values.base) {
      const missing = checkPullRequest({
        changedFiles: changedFiles(root, values.base),
        labels: parseLabels(values.labels),
        ...(values.branch ? { branch: values.branch } : {}),
      });
      if (missing) problems.push(missing);
    }
    if (problems.length > 0) {
      console.error(["Release notes need fixing:", ...problems.map((problem) => `  ${problem}`)].join("\n"));
      process.exitCode = 1;
    } else {
      console.log("Release notes are fine.");
    }
    return;
  }

  if (command === "release" && version) {
    const date = values.date ?? new Date().toISOString().slice(0, 10);
    const { folded } = releaseChangelog(root, version, date);
    console.log(`Moved ${folded.length} release note files into ${CHANGELOG} under ${version}.`);
    return;
  }

  console.error(
    "Usage: changelog.mts check [--base <rev>] [--labels <list>] [--branch <name>] | release <version> [--date YYYY-MM-DD]",
  );
  process.exitCode = 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
