// Proves each GritQL rule in tools/biome/rules flags exactly the lines its fixture marks.
//
//   node scripts/check-lint-rules.ts
//
// A rule's fixture is tools/biome/fixtures/<rule>.ts (or .tsx). Every line where the rule must
// report ends in `// flag`, on the line where the reported code starts; every other line is a case
// the rule must leave alone. Each rule runs alone in a scratch workspace with every built-in rule
// off, so only the plugin can report. A rule that matches nothing, a rule without a fixture and a
// rule that biome.json never loads all fail.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FLAG_MARKER = /\/\/ flag\s*$/;
const PLUGIN_ANNOTATION = /^::(?:error|warning|notice) title=plugin,.*?\bline=(\d+),/;

type MarkerDiff = { missed: number[]; unexpected: number[] };

type RuleResult = { rule: string; problems: string[]; biomeOutput: string };

/** 1-based numbers of the lines that end in `// flag`. */
export function markedLines(source: string): number[] {
  return source.split("\n").flatMap((line, index) => (FLAG_MARKER.test(line) ? [index + 1] : []));
}

/** Start lines of the plugin diagnostics in Biome's `--reporter=github` output, without repeats. */
export function flaggedLines(githubReport: string): number[] {
  const lines = new Set<number>();
  for (const row of githubReport.split("\n")) {
    const match = PLUGIN_ANNOTATION.exec(row.trim());
    if (match?.[1]) lines.add(Number(match[1]));
  }
  return [...lines].sort((a, b) => a - b);
}

function diffMarkers(marked: number[], flagged: number[]): MarkerDiff {
  return {
    missed: marked.filter((line) => !flagged.includes(line)),
    unexpected: flagged.filter((line) => !marked.includes(line)),
  };
}

/** Lists what is wrong with one rule given its fixture and Biome's report; empty means it passes. */
export function judgeRule(input: {
  rule: string;
  fixture: string | null;
  registered: boolean;
  report: string;
}): string[] {
  if (input.fixture === null) return [`${input.rule}: no fixture at tools/biome/fixtures/${input.rule}.ts`];
  const problems: string[] = [];
  if (!input.registered)
    problems.push(`${input.rule}: biome.json does not load rules/${input.rule}.grit, so lint never runs it`);
  const marked = markedLines(input.fixture);
  if (marked.length === 0)
    problems.push(`${input.rule}: the fixture marks no line with // flag, so nothing proves the rule matches`);
  const { missed, unexpected } = diffMarkers(marked, flaggedLines(input.report));
  if (missed.length > 0) problems.push(`${input.rule}: not reported on marked line(s) ${missed.join(", ")}`);
  if (unexpected.length > 0) problems.push(`${input.rule}: reported on unmarked line(s) ${unexpected.join(", ")}`);
  return problems;
}

function runBiome(biome: string, rulePath: string, fixturePath: string): string {
  const workspace = mkdtempSync(join(tmpdir(), "lint-rules-"));
  try {
    const config = {
      plugins: [rulePath],
      linter: { rules: { preset: "none" } },
      formatter: { enabled: false },
      assist: { enabled: false },
    };
    writeFileSync(join(workspace, "biome.json"), JSON.stringify(config));
    const target = `fixture${extname(fixturePath)}`;
    copyFileSync(fixturePath, join(workspace, target));
    const result = spawnSync(biome, ["lint", "--reporter=github", "--max-diagnostics=none", target], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return `${result.stdout}${result.stderr}`;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function checkLintRules(root: string): RuleResult[] {
  const rulesDir = join(root, "tools/biome/rules");
  const fixturesDir = join(root, "tools/biome/fixtures");
  const biomeConfig = readFileSync(join(root, "biome.json"), "utf8");
  const biome = join(root, "node_modules/.bin/biome");
  const fixtures = existsSync(fixturesDir) ? readdirSync(fixturesDir) : [];

  return readdirSync(rulesDir)
    .filter((file) => file.endsWith(".grit"))
    .sort()
    .map((file) => {
      const rule = basename(file, ".grit");
      const fixtureFile = fixtures.find((candidate) => candidate === `${rule}.ts` || candidate === `${rule}.tsx`);
      const fixturePath = fixtureFile ? join(fixturesDir, fixtureFile) : null;
      const biomeOutput = fixturePath ? runBiome(biome, join(rulesDir, file), fixturePath) : "";
      const problems = judgeRule({
        rule,
        fixture: fixturePath ? readFileSync(fixturePath, "utf8") : null,
        registered: biomeConfig.includes(`rules/${file}`),
        report: biomeOutput,
      });
      return { rule, problems, biomeOutput };
    });
}

function main(): void {
  const results = checkLintRules(resolve(import.meta.dirname, ".."));
  if (results.length === 0) {
    console.error("No .grit rules in tools/biome/rules.");
    process.exit(1);
  }
  let failed = false;
  for (const result of results) {
    if (result.problems.length === 0) {
      console.log(`ok   ${result.rule}`);
      continue;
    }
    failed = true;
    console.error(`FAIL ${result.problems.join("\n     ")}`);
    if (result.biomeOutput.trim())
      console.error(`     Biome said:\n${result.biomeOutput.trim().replace(/^/gm, "       ")}`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
