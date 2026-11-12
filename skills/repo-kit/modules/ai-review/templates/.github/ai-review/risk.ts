// Rates a pull request high or low risk from its changed files and the globs in risk.json. A low-risk
// pull request gets the `AI review` status without a model run; `/ai-review` still reviews it.
//
//   node risk.ts --files <file with one changed path per line> [--config <risk.json>]
//
// Prints each match, and writes `risk=high` or `risk=low` to $GITHUB_OUTPUT when it is set. The
// workflow runs a copy from the base commit, so a pull request cannot lower its own rating.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { matchesGlob } from "./compose-prompt.ts";
import { isRecord } from "./state.ts";

type RiskConfig = { categories: Record<string, string[]> };
type RiskMatch = { category: string; file: string };

export function parseRiskConfig(raw: unknown): RiskConfig {
  const categories = isRecord(raw) ? raw.categories : undefined;
  if (!isRecord(categories)) throw new Error('risk.json must be { "categories": { "<name>": ["<glob>", ...] } }');
  const parsed: Record<string, string[]> = {};
  for (const [name, globs] of Object.entries(categories)) {
    if (!Array.isArray(globs) || !globs.every((glob) => typeof glob === "string")) {
      throw new Error(`risk.json category "${name}" must be a list of globs`);
    }
    parsed[name] = globs;
  }
  return { categories: parsed };
}

/** High when any file matches a category, and when there are no files: an empty list proves nothing. */
export function classifyRisk(config: RiskConfig, files: string[]): { level: "high" | "low"; matches: RiskMatch[] } {
  const matches = files.flatMap((file) => {
    const category = Object.entries(config.categories).find(([, globs]) =>
      globs.some((glob) => matchesGlob(glob, file)),
    )?.[0];
    return category === undefined ? [] : [{ category, file }];
  });
  return { level: matches.length > 0 || files.length === 0 ? "high" : "low", matches };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { files: { type: "string" }, config: { type: "string" } } });
  if (!values.files) {
    console.error("usage: node risk.ts --files <file> [--config <risk.json>]");
    process.exit(2);
  }
  const config = parseRiskConfig(
    JSON.parse(readFileSync(values.config ?? join(import.meta.dirname, "risk.json"), "utf8")),
  );
  const files = readFileSync(values.files, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const { level, matches } = classifyRisk(config, files);
  for (const match of matches) console.log(`${match.category}: ${match.file}`);
  console.log(`Risk: ${level} (${files.length} changed files, ${matches.length} in a risky area).`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `risk=${level}\n`);
}
