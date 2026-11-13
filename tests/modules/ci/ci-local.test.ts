import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ciLocalSteps } from "../../../skills/repo-kit/modules/ci/templates/scripts/ci-local.mts";
import { buildVars } from "../../../skills/repo-kit/scripts/lib/apply.ts";
import { detect } from "../../../skills/repo-kit/scripts/lib/detect.ts";
import { renderTemplate } from "../../../skills/repo-kit/scripts/lib/render.ts";
import { applyModules, REPO_ROOT, removeTempDirs } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

const logged = (name: string) => `echo ${name} >> run.log`;

describe("the steps ci:local picks", () => {
  test("runs the project's checks in CI order and skips the ones it does not have", () => {
    const scripts = { test: "x", "check:docs": "x", lint: "x", typecheck: "x", dev: "x", "check:geometry": "x" };
    expect(ciLocalSteps(scripts)).toEqual(["lint", "typecheck", "test", "check:docs", "check:geometry"]);
  });

  test("covers every script the generated CI workflow runs", () => {
    const project = applyModules({ lockfile: "bun.lock", modules: ["ci"] });
    const modules = ["ci", "quality", "tests", "agent-docs", "supply-chain", "ui-geometry"];
    const source = readFileSync(join(REPO_ROOT, "skills/repo-kit/modules/ci/templates/.github/workflows/ci.yml"), "utf8");
    const workflow = renderTemplate(source, buildVars(detect(project), modules));
    const ciScripts = [...workflow.matchAll(/run: bun run (\S+)$/gm)].map((match) => match[1] ?? "");
    expect(ciScripts.length).toBeGreaterThan(0);
    const everyScript = Object.fromEntries(ciScripts.map((name) => [name, "x"]));
    expect(ciLocalSteps(everyScript).sort()).toEqual([...new Set(ciScripts)].sort());
  });
});

describe("running ci:local", () => {
  test("runs each present check in order and stops at the first failure with its exit code", () => {
    const project = applyModules({
      lockfile: "bun.lock",
      modules: ["ci"],
      packageJson: {
        scripts: {
          lint: logged("lint"),
          test: `${logged("test")} && exit 3`,
          "check:docs": logged("check:docs"),
        },
      },
    });
    const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    const run = spawnSync("bun", ["run", "ci:local"], { cwd: project, encoding: "utf8" });
    expect(pkg.scripts["ci:local"]).toBe("node scripts/ci-local.mts bun");
    expect(run.status).toBe(3);
    expect(readFileSync(join(project, "run.log"), "utf8")).toBe("lint\ntest\n");
    expect(run.stderr).toContain("ci:local: test failed");
  });

  test("passes when every check passes", () => {
    const project = applyModules({ lockfile: "bun.lock", modules: ["ci"], packageJson: { scripts: { lint: logged("lint") } } });
    const run = spawnSync("bun", ["run", "ci:local"], { cwd: project, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(readFileSync(join(project, "run.log"), "utf8")).toBe("lint\n");
    expect(run.stdout).toContain("ci:local: lint passed");
  });
});

test("AGENTS.md names ci:local only when the ci module provides it", () => {
  const withCi = applyModules({ lockfile: "pnpm-lock.yaml", modules: ["ci", "agent-docs"] });
  const withoutCi = applyModules({ lockfile: "pnpm-lock.yaml", modules: ["agent-docs"] });
  expect(readFileSync(join(withCi, "AGENTS.md"), "utf8")).toContain("`pnpm run ci:local` runs every check CI runs");
  expect(readFileSync(join(withoutCi, "AGENTS.md"), "utf8")).not.toContain("ci:local");
});
