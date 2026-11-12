// Layout check: runs the Playwright geometry project over every route and width in
// tests/geometry/geometry.config.json and compares the offenders with tests/geometry/baseline.json.
// Fails on a new offender, and on a baseline entry that no longer occurs, so the baseline only shrinks
// through a reviewed `--update`.
//
//   node scripts/check-geometry.mts [--update] [--config <path>] [-- <extra Playwright arguments>]
//
// `--update` rewrites the baseline from this run: the entries of every measured page are replaced, the
// rest are kept. A run that measured no page fails, so a broken setup cannot pass as a clean layout.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type BaselineEntry,
  compareWithBaseline,
  type PageResult,
  parseBaseline,
  parseGeometryConfig,
  parsePageResult,
  updateBaseline,
} from "../tests/geometry/geometry.ts";

function readResults(directory: string): PageResult[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => parsePageResult(JSON.parse(readFileSync(join(directory, file), "utf8"))));
}

function formatBaseline(entries: BaselineEntry[]): string {
  return `${JSON.stringify({ offenders: entries }, null, 2)}\n`;
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { update: { type: "boolean", default: false }, config: { type: "string" } },
    allowPositionals: true,
  });
  const root = resolve(import.meta.dirname, "..");
  const configPath = resolve(values.config ?? join(root, "tests/geometry/geometry.config.json"));
  const baselinePath = join(dirname(configPath), "baseline.json");
  const config = parseGeometryConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const resultsDir = join(root, ".artifacts/geometry");
  rmSync(resultsDir, { recursive: true, force: true });
  mkdirSync(resultsDir, { recursive: true });

  const command = [config.command, ...positionals.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)].join(" ");
  const run = spawnSync(command, {
    cwd: root,
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      GEOMETRY_CONFIG: configPath,
      GEOMETRY_RESULTS_DIR: resultsDir,
      GEOMETRY_UPDATE: values.update ? "1" : "0",
    },
  });
  const results = readResults(resultsDir);
  const baseline = parseBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));

  if (run.status !== 0) {
    console.error(`check:geometry: Playwright exited with ${run.status ?? run.signal}; the baseline was not changed.`);
    process.exitCode = run.status ?? 1;
    return;
  }
  if (results.length === 0) {
    console.error(
      "check:geometry: no page was measured. Check the command in geometry.config.json and the Playwright project.",
    );
    process.exitCode = 1;
    return;
  }

  if (values.update) {
    const updated = updateBaseline(baseline, results);
    writeFileSync(baselinePath, formatBaseline(updated));
    console.log(
      `check:geometry: measured ${results.length} pages; the baseline now holds ${updated.length} offenders.`,
    );
    return;
  }

  const { added, fixed } = compareWithBaseline(baseline, results);
  for (const line of added) console.error(`new: ${line}`);
  for (const entry of fixed) console.error(`fixed: ${entry.route} @${entry.width} ${entry.rule} ${entry.element}`);
  if (fixed.length > 0)
    console.error(
      "check:geometry: offenders above are gone. Run check:geometry --update to drop them from the baseline.",
    );
  if (added.length > 0 || fixed.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`check:geometry: measured ${results.length} pages; no new layout offenders.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
