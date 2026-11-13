import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BaselineEntry,
  compareWithBaseline,
  type PageResult,
  parseGeometryConfig,
  updateBaseline,
} from "../../../skills/repo-kit/modules/ui-geometry/templates/tests/geometry/geometry.ts";
import { applyModules, removeTempDirs } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

const small = (element: string) => ({ rule: "small-target" as const, element, detail: "30x30px, under 44x44px" });
const entry = (route: string, width: number, element: string): BaselineEntry => ({ route, width, rule: "small-target", element });

describe("comparing with the baseline", () => {
  const baseline = [entry("/", 390, 'button "Close"'), entry("/", 390, "a#help"), entry("/settings", 390, "button#save")];

  test("reports offenders the baseline does not list, and listed ones that are gone from the pages measured", () => {
    const results: PageResult[] = [{ route: "/", width: 390, offenders: [small('button "Close"'), small('button "Menu"')] }];
    expect(compareWithBaseline(baseline, results)).toEqual({
      added: ['/ @390 small-target button "Menu": 30x30px, under 44x44px'],
      fixed: [entry("/", 390, "a#help")],
    });
  });

  test("matches by route, width, rule and element, not by pixel detail", () => {
    const results: PageResult[] = [
      { route: "/", width: 390, offenders: [{ ...small('button "Close"'), detail: "31x29px" }, small("a#help")] },
    ];
    expect(compareWithBaseline(baseline, results)).toEqual({ added: [], fixed: [] });
    expect(compareWithBaseline(baseline, [{ route: "/", width: 320, offenders: [small('button "Close"')] }]).added).toHaveLength(1);
  });

  test("an update replaces only the measured pages and sorts the result", () => {
    const results: PageResult[] = [{ route: "/", width: 390, offenders: [small("button#z"), small("a#b")] }];
    expect(updateBaseline(baseline, results)).toEqual([
      entry("/", 390, "a#b"),
      entry("/", 390, "button#z"),
      entry("/settings", 390, "button#save"),
    ]);
  });
});

describe("the geometry config", () => {
  test("takes paths or path and selector pairs, with defaults for the rest", () => {
    const config = parseGeometryConfig({
      command: "playwright test",
      routes: ["/", { path: "/inbox", waitFor: "main h1" }],
      widths: [320],
    });
    expect(config).toEqual({
      command: "playwright test",
      routes: [
        { path: "/", waitFor: null },
        { path: "/inbox", waitFor: "main h1" },
      ],
      widths: [320],
      phoneMaxWidth: 480,
      viewportHeight: 800,
      ignore: [],
    });
  });

  test("rejects a route that is not a path", () => {
    expect(() => parseGeometryConfig({ command: "x", routes: ["inbox"], widths: [320] })).toThrow("routes[0] must be a path");
  });
});

describe("check:geometry", () => {
  /** A project whose Playwright command is a stub that writes the given page results, then exits with `exitCode`. */
  function project(results: PageResult[], exitCode = 0, baseline: BaselineEntry[] = []): string {
    const root = applyModules({ lockfile: "pnpm-lock.yaml", modules: ["ui-geometry"] });
    const stub = [
      'const { mkdirSync, writeFileSync } = require("node:fs");',
      "const dir = process.env.GEOMETRY_RESULTS_DIR;",
      "mkdirSync(dir, { recursive: true });",
      `for (const [index, result] of ${JSON.stringify(results)}.entries()) writeFileSync(dir + "/" + index + ".json", JSON.stringify(result));`,
      `process.exit(${exitCode});`,
    ].join("\n");
    writeFileSync(join(root, "stub.cjs"), stub);
    const configPath = join(root, "tests/geometry/geometry.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const routes = [...new Set(results.map((result) => result.route))];
    const widths = [...new Set(results.map((result) => result.width))];
    const measured = results.length > 0 ? { routes, widths } : {};
    writeFileSync(configPath, JSON.stringify({ ...config, ...measured, command: "node stub.cjs" }));
    writeFileSync(join(root, "tests/geometry/baseline.json"), JSON.stringify({ offenders: baseline }));
    return root;
  }

  const run = (root: string, ...args: string[]) =>
    spawnSync("node", ["scripts/check-geometry.mts", ...args], { cwd: root, encoding: "utf8" });
  const readBaseline = (root: string) => JSON.parse(readFileSync(join(root, "tests/geometry/baseline.json"), "utf8"));

  test("fails on a new offender and names it", () => {
    const root = project([{ route: "/", width: 390, offenders: [small('button "Menu"')] }]);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('new: / @390 small-target button "Menu": 30x30px, under 44x44px');
  });

  test("names the new offender when the Playwright check itself fails on it", () => {
    const root = project([{ route: "/", width: 390, offenders: [small('button "Menu"')] }], 1);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('new: / @390 small-target button "Menu": 30x30px, under 44x44px');
  });

  test("fails when Playwright passes without measuring every route at every width", () => {
    const root = project([{ route: "/", width: 390, offenders: [] }]);
    const configPath = join(root, "tests/geometry/geometry.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, routes: ["/", "/settings"] }));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("measured 1 of 2 pages; missing: /settings @390");
  });

  test("passes when every offender is in the baseline", () => {
    const root = project([{ route: "/", width: 390, offenders: [small('button "Menu"')] }], 0, [entry("/", 390, 'button "Menu"')]);
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("measured 1 pages; no new layout offenders");
  });

  test("fails when a baseline entry no longer occurs, until --update drops it", () => {
    const root = project([{ route: "/", width: 390, offenders: [] }], 0, [entry("/", 390, 'button "Menu"')]);
    const check = run(root);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('fixed: / @390 small-target button "Menu"');

    expect(run(root, "--update").status).toBe(0);
    expect(readBaseline(root)).toEqual({ offenders: [] });
    expect(run(root).status).toBe(0);
  });

  test("--update records the offenders found", () => {
    const root = project([{ route: "/", width: 320, offenders: [small("a#help")] }]);
    expect(run(root, "--update").status).toBe(0);
    expect(readBaseline(root)).toEqual({ offenders: [entry("/", 320, "a#help")] });
  });

  test("fails without touching the baseline when Playwright fails or measures nothing", () => {
    const failing = project([{ route: "/", width: 320, offenders: [small("a#help")] }], 1);
    expect(run(failing, "--update").status).toBe(1);
    expect(readBaseline(failing)).toEqual({ offenders: [] });

    const empty = run(project([]));
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("no page was measured");
  });
});
