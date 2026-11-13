import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadModules, selectAll } from "../skills/repo-kit/scripts/lib/modules.ts";
import { applyModules, type Lockfile, REPO_ROOT, removeTempDirs } from "./helpers/render-module.ts";

afterAll(removeTempDirs);

const kit = loadModules(join(REPO_ROOT, "skills/repo-kit/modules"));
/** What `--modules all` selects: on a fresh project, and on one that recorded the `opencodereview` alternative. */
const selections: [string, string[]][] = [
  ["ai-review", selectAll(kit, [])],
  ["opencodereview", selectAll(kit, ["opencodereview"])],
];
const cases = selections.flatMap(([reviewer, modules]) =>
  (["bun.lock", "pnpm-lock.yaml"] as Lockfile[]).map((lockfile) => ({ reviewer, modules, lockfile })),
);

describe.each(cases)("every module applied together with $reviewer ($lockfile)", ({ modules, lockfile }) => {
  test("the project passes its own Biome check with no edits", () => {
    const project = applyModules({ lockfile, modules, linkNodeModules: true });
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
