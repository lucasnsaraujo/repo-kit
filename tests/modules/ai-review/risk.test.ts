import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyRisk, parseRiskConfig } from "../../../skills/repo-kit/modules/ai-review/templates/.github/ai-review/risk.ts";

const KIT = resolve(import.meta.dirname, "../../../skills/repo-kit/modules/ai-review/templates/.github/ai-review");
const shipped = parseRiskConfig(JSON.parse(readFileSync(join(KIT, "risk.json"), "utf8")));

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the shipped risk globs", () => {
  test.each([
    ["auth", "src/lib/auth/session.ts"],
    ["auth", "apps/web/middleware.ts"],
    ["auth", "apps/web/app/(auth)/login/page.tsx"],
    ["payments", "apps/web/app/api/stripe/webhook/route.ts"],
    ["payments", "src/billing/invoice.ts"],
    ["migrations", "db/migrations/0003_add_orders.sql"],
    ["migrations", "packages/db/prisma/schema.prisma"],
    ["secrets", ".env.production"],
    ["secrets", "apps/web/src/env.ts"],
    ["ci", ".github/workflows/ci.yml"],
    ["ci", ".github/ai-review/risk.json"],
  ])("rate a %s change high risk: %s", (category, file) => {
    expect(classifyRisk(shipped, ["README.md", file])).toEqual({ level: "high", matches: [{ category, file }] });
  });

  test("rate UI, docs and ordinary source changes low risk", () => {
    const files = ["src/components/Button.tsx", "src/app/page.tsx", "README.md", "src/lib/format-date.ts", "tests/geometry/baseline.json"];
    expect(classifyRisk(shipped, files)).toEqual({ level: "low", matches: [] });
  });
});

describe("classification", () => {
  test("rates a pull request with no listed files high, since nothing proves it safe", () => {
    expect(classifyRisk(shipped, [])).toEqual({ level: "high", matches: [] });
  });

  test("lists every match so the reason is visible in the run log", () => {
    const config = parseRiskConfig({ categories: { auth: ["**/auth/**"], ci: [".github/**"] } });
    expect(classifyRisk(config, ["src/auth/a.ts", ".github/workflows/x.yml", "src/auth/b.ts"]).matches).toEqual([
      { category: "auth", file: "src/auth/a.ts" },
      { category: "ci", file: ".github/workflows/x.yml" },
      { category: "auth", file: "src/auth/b.ts" },
    ]);
  });

  test("rejects a config that is not categories of glob lists", () => {
    expect(() => parseRiskConfig({ categories: { auth: "**/auth/**" } })).toThrow("risk.json");
    expect(() => parseRiskConfig({ auth: ["**/auth/**"] })).toThrow("risk.json");
  });
});

describe("command line", () => {
  function run(files: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "ai-review-risk-"));
    temps.push(dir);
    writeFileSync(join(dir, "files.txt"), `${files.join("\n")}\n`);
    writeFileSync(join(dir, "output"), "");
    const result = spawnSync("node", [join(KIT, "risk.ts"), "--files", join(dir, "files.txt")], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: join(dir, "output") },
    });
    return { ...result, output: readFileSync(join(dir, "output"), "utf8") };
  }

  test("writes risk=low for a low-risk change", () => {
    const result = run(["src/components/Button.tsx"]);
    expect(result.status).toBe(0);
    expect(result.output).toBe("risk=low\n");
  });

  test("writes risk=high and names the matching files", () => {
    const result = run(["src/components/Button.tsx", "supabase/migrations/0001_init.sql"]);
    expect(result.output).toBe("risk=high\n");
    expect(result.stdout).toContain("migrations: supabase/migrations/0001_init.sql");
  });
});

test("the ship skill reads the exact status the low-risk job writes", () => {
  const modules = resolve(import.meta.dirname, "../../../skills/repo-kit/modules");
  const workflow = Bun.YAML.parse(readFileSync(join(modules, "ai-review/templates/.github/workflows/ai-review.yml"), "utf8"));
  const run = JSON.stringify(workflow).match(/skip-low-risk.*?description=\\"([^"\\]+)\\"/)?.[1];
  const ship = readFileSync(join(modules, "agent-loops/templates/.agents/skills/ship/SKILL.md"), "utf8");
  expect(run).toBe("low risk: review not required");
  expect(ship).toContain(`\`success ${run}\``);
});
