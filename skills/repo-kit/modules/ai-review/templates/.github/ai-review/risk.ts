// Rates a pull request high or low risk from its changed files and the globs in risk.json. A low-risk
// pull request gets the `AI review` status without a model run; `/ai-review` still reviews it. One
// whose last review still has an open P0 or P1 stays high, so a trivial push cannot clear a blocker.
//
//   node risk.ts --files <file with one changed path per line> [--context <collect.ts output>] [--config <risk.json>]
//
// Prints each match, and writes `risk=high` or `risk=low` to $GITHUB_OUTPUT when it is set. The
// workflow runs a copy from the base commit, so a pull request cannot lower its own rating.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readContext } from "./collect.ts";
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

/**
 * High when any file matches a category (ignoring case, so `useAuth.ts` counts), when a blocking
 * finding is still open, and when there are no files: an empty list proves nothing.
 */
export function classifyRisk(
  config: RiskConfig,
  files: string[],
  openBlockingFindings = 0,
): { level: "high" | "low"; matches: RiskMatch[] } {
  const matches = files.flatMap((file) => {
    const path = file.toLowerCase();
    const category = Object.entries(config.categories).find(([, globs]) =>
      globs.some((glob) => matchesGlob(glob.toLowerCase(), path)),
    )?.[0];
    return category === undefined ? [] : [{ category, file }];
  });
  const high = matches.length > 0 || files.length === 0 || openBlockingFindings > 0;
  return { level: high ? "high" : "low", matches };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { files: { type: "string" }, context: { type: "string" }, config: { type: "string" } },
  });
  if (!values.files) {
    console.error("usage: node risk.ts --files <file> [--context <file>] [--config <risk.json>]");
    process.exit(2);
  }
  const config = parseRiskConfig(
    JSON.parse(readFileSync(values.config ?? join(import.meta.dirname, "risk.json"), "utf8")),
  );
  const files = readFileSync(values.files, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const previous = values.context ? readContext(JSON.parse(readFileSync(values.context, "utf8"))).previous : null;
  const blocking = (previous?.state.active ?? []).filter(
    (finding) => finding.priority === "P0" || finding.priority === "P1",
  );
  const { level, matches } = classifyRisk(config, files, blocking.length);
  for (const match of matches) console.log(`${match.category}: ${match.file}`);
  if (blocking.length > 0) console.log(`The last review left ${blocking.length} P0/P1 findings open.`);
  console.log(`Risk: ${level} (${files.length} changed files, ${matches.length} in a risky area).`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `risk=${level}\n`);
}
