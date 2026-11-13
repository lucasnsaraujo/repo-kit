import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyModules, removeTempDirs, writeFiles } from "../../helpers/render-module.ts";

afterAll(removeTempDirs);

test("check:geometry drives the real Playwright test file against a served page", () => {
  const project = applyModules({ lockfile: "bun.lock", modules: ["ui-geometry"], linkNodeModules: true });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  writeFiles(project, {
    "site/index.html":
      '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>' +
      '<body style="margin:0"><main><button aria-label="Close" style="width:30px;height:30px">x</button></main></body></html>',
    "playwright.config.ts": [
      'import { defineConfig } from "@playwright/test";',
      "export default defineConfig({",
      `  webServer: { command: "python3 -m http.server ${port} --bind 127.0.0.1 --directory site", url: "http://127.0.0.1:${port}/" },`,
      `  use: { baseURL: "http://127.0.0.1:${port}" },`,
      '  projects: [{ name: "geometry", testDir: "./tests/geometry", testMatch: "geometry.check.ts" }],',
      "});",
    ].join("\n"),
    "tests/geometry/geometry.config.json": JSON.stringify({
      command: "./node_modules/.bin/playwright test --project=geometry --reporter=line",
      routes: ["/"],
      widths: [390, 1280],
    }),
  });
  const run = (...args: string[]) => spawnSync("node", ["scripts/check-geometry.mts", ...args], { cwd: project, encoding: "utf8" });

  const first = run();
  expect(`${first.stdout}${first.stderr}`).toContain('/ @390 small-target main > button[aria-label=\\"Close\\"]');
  expect(first.status).toBe(1);

  expect(run("--update").status).toBe(0);
  expect(JSON.parse(readFileSync(join(project, "tests/geometry/baseline.json"), "utf8"))).toEqual({
    offenders: [{ route: "/", width: 390, rule: "small-target", element: 'main > button[aria-label="Close"]' }],
  });

  const accepted = run();
  expect(accepted.stdout).toContain("measured 2 pages; no new layout offenders");
  expect(accepted.status).toBe(0);
}, 120_000);
