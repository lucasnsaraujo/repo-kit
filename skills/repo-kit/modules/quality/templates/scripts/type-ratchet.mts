// Holds each strict TypeScript option that tsconfig does not turn on yet to the error count it
// would cause in each file, as recorded in tools/ratchet/types.json.
//
//   node scripts/type-ratchet.mts                       fails on new errors and on stale counts
//   node scripts/type-ratchet.mts --write               lowers the baseline after a fix
//   node scripts/type-ratchet.mts --add=<option>        starts holding another option
//   node scripts/type-ratchet.mts --project=<tsconfig>  checks this project instead (repeatable)
//
// Each held option runs `tsc --noEmit --pretty false --<option>` once per project. Once an option has no errors left, turn it on in tsconfig.json and
// delete its key from the baseline.

// The baseline rules: a file whose count rises above its baseline fails, so new debt stops before
// the old debt is paid. A count that drops also fails until `--write` lowers the baseline, so a
// later regression cannot hide in the slack. `--write` never raises a count: raising one is a hand
// edit of the baseline that a reviewer sees in the diff. `--add=<option>` starts holding an option
// at its current counts. An option with no errors left fails until it is turned on and deleted
// from the baseline. With every strict option already on there is nothing to hold, and it passes.
//
// The script is self-contained (no sibling imports) so any tsconfig that includes scripts/ can
// typecheck it. Copy runRatchet into another script to ratchet a different count.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Findings by check name, then by file path. */
export type Counts = Record<string, Record<string, number>>;

type Change = { check: string; file: string; baseline: number; current: number };

type Comparison = {
  worse: Change[];
  better: Change[];
  /** Checks with no findings left in any file. */
  finished: string[];
};

export type Ratchet = {
  /** The package script that runs this ratchet, used in messages: `types:ratchet`. */
  script: string;
  baselinePath: string;
  /** What one finding is, in the plural: `type errors`. */
  noun: string;
  /** Checks to suggest when no baseline exists yet; none means nothing to hold, which passes. */
  suggestedChecks: string[];
  /** What to do once a check has no findings left. */
  finishedStep: (check: string) => string;
  count: (checks: string[]) => Counts;
};

function compareCounts(baseline: Counts, current: Counts): Comparison {
  const worse: Change[] = [];
  const better: Change[] = [];
  const finished: string[] = [];
  for (const [check, files] of Object.entries(baseline)) {
    const now = current[check] ?? {};
    for (const file of new Set([...Object.keys(files), ...Object.keys(now)])) {
      const change = { check, file, baseline: files[file] ?? 0, current: now[file] ?? 0 };
      if (change.current > change.baseline) worse.push(change);
      else if (change.current < change.baseline) better.push(change);
    }
    if (Object.values(now).every((count) => count === 0)) finished.push(check);
  }
  return { worse, better, finished };
}

/** Takes each count down to its current value, never up, and drops files at zero. A check with no files left stays, so it keeps failing until someone finishes it. */
function lowerBaseline(baseline: Counts, current: Counts): Counts {
  const lowered: Counts = {};
  for (const [check, files] of Object.entries(baseline)) {
    const kept: Record<string, number> = {};
    for (const [file, count] of Object.entries(files)) {
      const next = Math.min(count, current[check]?.[file] ?? 0);
      if (next > 0) kept[file] = next;
    }
    lowered[check] = kept;
  }
  return lowered;
}

/** Records the current counts of checks the baseline does not hold yet. */
function startChecks(baseline: Counts, current: Counts, checks: string[]): Counts {
  const started: Counts = { ...baseline };
  for (const check of checks) {
    if (Object.hasOwn(baseline, check)) throw new Error(`${check} is already in the baseline`);
    started[check] = Object.fromEntries(Object.entries(current[check] ?? {}).filter(([, count]) => count > 0));
  }
  return started;
}

function sortCounts(counts: Counts): Counts {
  const sortKeys = <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return sortKeys(Object.fromEntries(Object.entries(counts).map(([check, files]) => [check, sortKeys(files)])));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBaseline(path: string): Counts | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} must hold a JSON object`);
  const counts: Counts = {};
  for (const [check, files] of Object.entries(parsed)) {
    if (!isRecord(files)) throw new Error(`${path}: ${check} must map files to counts`);
    const fileCounts: Record<string, number> = {};
    for (const [file, count] of Object.entries(files)) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
        throw new Error(`${path}: ${check} -> ${file} must be a whole number`);
      fileCounts[file] = count;
    }
    counts[check] = fileCounts;
  }
  return counts;
}

/** Runs one ratchet with command-line arguments and returns the exit code. */
export function runRatchet(ratchet: Ratchet, args: string[], log: (line: string) => void = console.log): number {
  const write = args.includes("--write");
  const added = args.flatMap((arg) => (arg.startsWith("--add=") ? [arg.slice("--add=".length)] : []));
  const stored = readBaseline(ratchet.baselinePath);

  if (stored === null && added.length === 0) {
    if (ratchet.suggestedChecks.length === 0) {
      log(`Nothing to hold: no baseline at ${ratchet.baselinePath} and no check left to start.`);
      return 0;
    }
    const adds = ratchet.suggestedChecks.map((check) => `--add=${check}`).join(" ");
    log(`No baseline at ${ratchet.baselinePath}. Start one with: ${ratchet.script} ${adds}`);
    return 1;
  }

  const checks = [...Object.keys(stored ?? {}), ...added];
  const current = ratchet.count(checks);
  const baseline = startChecks(stored ?? {}, current, added);
  const { worse, better, finished } = compareCounts(baseline, current);

  for (const change of worse) {
    log(
      `${change.file}: ${change.current} ${ratchet.noun} under ${change.check}, baseline allows ${change.baseline}. Fix the new ones.`,
    );
  }

  if (write || added.length > 0) {
    const next = lowerBaseline(baseline, current);
    mkdirSync(dirname(ratchet.baselinePath), { recursive: true });
    writeFileSync(ratchet.baselinePath, `${JSON.stringify(sortCounts(next), null, 2)}\n`);
    for (const change of better)
      log(`${change.file}: ${change.check} lowered from ${change.baseline} to ${change.current}.`);
    for (const check of added)
      log(`${check}: started at ${Object.values(next[check] ?? {}).reduce((sum, n) => sum + n, 0)} ${ratchet.noun}.`);
    for (const check of finished) log(`${check}: no ${ratchet.noun} left. ${ratchet.finishedStep(check)}`);
    return worse.length > 0 ? 1 : 0;
  }

  for (const change of better) {
    log(
      `${change.file}: ${change.check} dropped from ${change.baseline} to ${change.current}. Run ${ratchet.script} --write to lower the baseline.`,
    );
  }
  for (const check of finished) log(`${check}: no ${ratchet.noun} left. ${ratchet.finishedStep(check)}`);
  return worse.length > 0 || better.length > 0 || finished.length > 0 ? 1 : 0;
}

const STRICT_OPTIONS = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noPropertyAccessFromIndexSignature",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
];

const ERROR_LINE = /^(.+?)\(\d+,\d+\): error TS\d+: /;

/** Error counts by file in `tsc --pretty false` output; the same error printed twice counts once. */
export function countErrorsByFile(output: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of new Set(output.split("\n"))) {
    const file = ERROR_LINE.exec(line)?.[1];
    if (file === undefined) continue;
    const path = file.replaceAll("\\", "/");
    counts[path] = (counts[path] ?? 0) + 1;
  }
  return counts;
}

/** The strict options that `tsc --showConfig` output does not turn on. */
export function pendingOptions(showConfig: string): string[] {
  const parsed: { compilerOptions?: Record<string, unknown> } = JSON.parse(showConfig);
  const options = parsed.compilerOptions ?? {};
  return STRICT_OPTIONS.filter((option) => options[option] !== true);
}

function tscBinary(root: string): string {
  const local = join(root, "node_modules/.bin/tsc");
  return existsSync(local) ? local : "tsc";
}

function runTsc(root: string, args: string[]): { output: string; status: number | null } {
  const result = spawnSync(tscBinary(root), args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

function countOption(root: string, projects: string[], option: string): Record<string, number> {
  const errorLines = new Set<string>();
  for (const project of projects) {
    const { output, status } = runTsc(root, ["-p", project, "--noEmit", "--pretty", "false", `--${option}`]);
    const lines = output.split("\n").filter((line) => ERROR_LINE.test(line));
    if (status !== 0 && lines.length === 0)
      throw new Error(`tsc -p ${project} --${option} failed without file errors:\n${output}`);
    for (const line of lines) errorLines.add(line);
  }
  return countErrorsByFile([...errorLines].join("\n"));
}

function main(): void {
  const root = resolve(import.meta.dirname, "..");
  const args = process.argv.slice(2);
  const projectArgs = args.flatMap((arg) => (arg.startsWith("--project=") ? [arg.slice("--project=".length)] : []));
  const projects = projectArgs.length > 0 ? projectArgs : ["tsconfig.json"];
  const pending = new Set(
    projects.flatMap((project) => pendingOptions(runTsc(root, ["-p", project, "--showConfig"]).output)),
  );

  for (const arg of args) {
    const option = arg.startsWith("--add=") ? arg.slice("--add=".length) : null;
    if (option !== null && !pending.has(option)) {
      console.error(
        `${option} is not a strict option that ${projects.join(", ")} leaves off. Pick from: ${[...pending].join(", ")}`,
      );
      process.exit(1);
    }
  }

  const code = runRatchet(
    {
      script: "node scripts/type-ratchet.mts",
      baselinePath: join(root, "tools/ratchet/types.json"),
      noun: "type errors",
      suggestedChecks: [...pending],
      finishedStep: (option) =>
        `Set "${option}": true in tsconfig.json and delete "${option}" from tools/ratchet/types.json.`,
      count: (options): Counts =>
        Object.fromEntries(options.map((option) => [option, countOption(root, projects, option)])),
    },
    args,
  );
  process.exit(code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
