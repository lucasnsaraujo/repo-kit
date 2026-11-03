import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { applyModules, removeTempDirs } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

test("a project with ci, quality, tests and hooks passes its own lint and format check", () => {
  const project = applyModules({ lockfile: "bun.lock", modules: ["ci", "quality", "tests", "hooks"], linkNodeModules: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  const lint = spawnSync("node_modules/.bin/biome", ["check", "--max-diagnostics=none", "."], { cwd: project, encoding: "utf8" });
  expect(lint.stderr.split("\n").filter((line) => line.includes("━━"))).toEqual([]);
  expect(lint.status).toBe(0);
});
