import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flaggedLines, judgeRule, markedLines } from "../../../skill/modules/quality/templates/scripts/check-lint-rules.ts";
import { applyModules, removeTempDirs, writeFiles } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

const report = (lines: number[], title = "plugin") =>
  lines.map((line) => `::error title=${title},file=/tmp/x/fixture.ts,line=${line},endLine=${line},col=1,endColumn=9::message`).join("\n");

describe("markers and reports", () => {
  test("markedLines finds the lines that end in the flag marker", () => {
    expect(markedLines("a();\nb(); // flag\nc(); // flagged later\nd(); // flag  \n")).toEqual([2, 4]);
  });

  test("flaggedLines keeps plugin annotations only, once per line", () => {
    const output = [report([7, 3, 3]), report([5], "lint/correctness/noUnusedVariables"), "lint ━━━━", "  × Some errors were emitted"].join(
      "\n",
    );
    expect(flaggedLines(output)).toEqual([3, 7]);
  });
});

describe("judgeRule", () => {
  const fixture = "ok();\nbad(); // flag\nbad(); // flag\n";

  test("passes when the reported lines are exactly the marked ones", () => {
    expect(judgeRule({ rule: "r", fixture, registered: true, report: report([2, 3]) })).toEqual([]);
  });

  test("names the marked lines the rule missed and the unmarked lines it reported", () => {
    expect(judgeRule({ rule: "r", fixture, registered: true, report: report([1, 2]) })).toEqual([
      "r: not reported on marked line(s) 3",
      "r: reported on unmarked line(s) 1",
    ]);
  });

  test("fails a rule that matches nothing", () => {
    expect(judgeRule({ rule: "r", fixture, registered: true, report: "" })).toContain("r: not reported on marked line(s) 2, 3");
  });

  test("fails a rule without a fixture, without markers, or missing from biome.json", () => {
    expect(judgeRule({ rule: "r", fixture: null, registered: true, report: "" })).toEqual(["r: no fixture at tools/biome/fixtures/r.ts"]);
    expect(judgeRule({ rule: "r", fixture: "ok();\n", registered: true, report: "" })[0]).toContain("marks no line");
    expect(judgeRule({ rule: "r", fixture, registered: false, report: report([2, 3]) })[0]).toContain("does not load rules/r.grit");
  });
});

describe("the shipped rules under the installed Biome", () => {
  const run = (project: string) => spawnSync("node", ["scripts/check-lint-rules.ts"], { cwd: project, encoding: "utf8" });

  test("every rule flags exactly its fixture's marked lines", () => {
    const project = applyModules({ lockfile: "bun.lock", modules: ["quality"], linkNodeModules: true });
    const result = run(project);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(5);
  });

  test("a fixture that claims a line the rule does not report fails the check", () => {
    const project = applyModules({ lockfile: "pnpm-lock.yaml", modules: ["quality"], linkNodeModules: true });
    const fixturePath = join(project, "tools/biome/fixtures/no-snapshot-assertions.ts");
    writeFileSync(
      fixturePath,
      readFileSync(fixturePath, "utf8").replace("expect(invoice.total).toBe(10);", "expect(invoice.total).toBe(10); // flag"),
    );
    const result = run(project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no-snapshot-assertions: not reported on marked line(s) 8");
  });

  test("biome.json applies the rules to test files and leaves other files alone", () => {
    const project = applyModules({ lockfile: "bun.lock", modules: ["quality"], linkNodeModules: true });
    const body = 'import { expect, test } from "vitest";\n\ntest("x", () => {\n  expect(1).toMatchSnapshot();\n});\n';
    writeFiles(project, { "src/a.test.ts": body, "src/helper.ts": body });
    const lint = spawnSync("node_modules/.bin/biome", ["lint", "--reporter=github", "src"], { cwd: project, encoding: "utf8" });
    const flagged = lint.stdout.split("\n").filter((line) => line.includes("title=plugin"));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain("src/a.test.ts,line=4");
  });
});
