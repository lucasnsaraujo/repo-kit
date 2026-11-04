import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadModules, selectAll } from "../skills/repo-kit/scripts/lib/modules.ts";
import { applyModules, type Lockfile, REPO_ROOT, removeTempDirs } from "./helpers/render-module.ts";

afterAll(removeTempDirs);

/** What `--modules all` selects on a fresh project: opt-in alternatives such as `opencodereview` are left out. */
const allModules = selectAll(loadModules(join(REPO_ROOT, "skills/repo-kit/modules")), []);

describe.each<Lockfile>(["bun.lock", "pnpm-lock.yaml"])("every module applied together (%s)", (lockfile) => {
  test("the project passes its own Biome check with no edits", () => {
    const project = applyModules({ lockfile, modules: allModules, linkNodeModules: true });
    spawnSync("git", ["init", "-q"], { cwd: project });

    const biome = spawnSync(join(REPO_ROOT, "node_modules/.bin/biome"), ["check", "--max-diagnostics=20", "."], {
      cwd: project,
      encoding: "utf8",
    });
    const output = `${biome.stdout}${biome.stderr}`;
    expect(output).not.toMatch(/Found \d+ (error|warning)/);
    expect(biome.status).toBe(0);
  });
});
