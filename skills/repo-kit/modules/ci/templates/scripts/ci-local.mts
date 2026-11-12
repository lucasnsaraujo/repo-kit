// Runs, in order, the checks .github/workflows/ci.yml runs, so a branch can be proven green before
// it is pushed. Each check is a package.json script; a script the project does not have is skipped.
// Stops at the first failure and exits with its code.
//
//   node scripts/ci-local.mts <bun|pnpm>
//
// The secret scan stays in CI: it needs the gitleaks binary and the pull request's commit range.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CI_ORDER = [
  "lint",
  "typecheck",
  "knip",
  "types:ratchet",
  "check:lint-rules",
  "test",
  "check:docs",
  "check:geometry",
] as const;

const PACKAGE_MANAGERS = new Set(["bun", "pnpm"]);

export function ciLocalSteps(scripts: Record<string, string>): string[] {
  return CI_ORDER.filter((name) => Object.hasOwn(scripts, name));
}

function main(): void {
  const pm = process.argv[2] ?? "";
  if (!PACKAGE_MANAGERS.has(pm)) {
    console.error("usage: node scripts/ci-local.mts <bun|pnpm>");
    process.exitCode = 2;
    return;
  }
  const root = resolve(import.meta.dirname, "..");
  const pkg: { scripts?: Record<string, string> } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const steps = ciLocalSteps(pkg.scripts ?? {});
  for (const step of steps) {
    console.log(`ci:local: ${pm} run ${step}`);
    const result = spawnSync(pm, ["run", step], { cwd: root, stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`ci:local: ${step} failed${result.error ? `: ${result.error.message}` : ""}`);
      process.exitCode = result.status ?? 1;
      return;
    }
    console.log(`ci:local: ${step} passed`);
  }
  console.log(`ci:local: ${steps.length} checks passed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
