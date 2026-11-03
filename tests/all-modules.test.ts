import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { applyModules, type Lockfile, REPO_ROOT, removeTempDirs } from "./helpers/render-module.ts";

afterAll(removeTempDirs);

const allModules = readdirSync(join(REPO_ROOT, "skill/modules"));

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
