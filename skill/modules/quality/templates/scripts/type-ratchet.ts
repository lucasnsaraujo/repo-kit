// Holds each strict TypeScript option that tsconfig does not turn on yet to the error count it
// would cause in each file, as recorded in tools/ratchet/types.json.
//
//   node scripts/type-ratchet.ts                       fails on new errors and on stale counts
//   node scripts/type-ratchet.ts --write               lowers the baseline after a fix
//   node scripts/type-ratchet.ts --add=<option>        starts holding another option
//   node scripts/type-ratchet.ts --project=<tsconfig>  checks this project instead (repeatable)
//
// Each held option runs `tsc --noEmit --pretty false --<option>` once per project. debt-ratchet.ts
// has the baseline rules. Once an option has no errors left, turn it on in tsconfig.json and
// delete its key from the baseline.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Counts, runRatchet } from "./debt-ratchet.ts";

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
      script: "node scripts/type-ratchet.ts",
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
