import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkDocs } from "../../../skill/modules/agent-docs/templates/scripts/check-docs.mts";

const SCRIPT = resolve(import.meta.dirname, "../../../skill/modules/agent-docs/templates/scripts/check-docs.mts");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-docs-"));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const lines = (count: number) => `${Array.from({ length: count }, (_, index) => `line ${index}`).join("\n")}\n`;
const budget = { root: 300, nested: 150 };

describe("links", () => {
  test("reports a relative link to a file that does not exist, with its line", () => {
    const root = project({ "README.md": "# Title\n\nSee [setup](docs/setup.md).\n" });
    expect(checkDocs(root, { files: ["README.md"], budget })).toEqual([
      { file: "README.md", line: 3, message: "docs/setup.md names docs/setup.md, which does not exist" },
    ]);
  });

  test("reports an anchor the target file does not have", () => {
    const root = project({
      "README.md": "[rules](docs/guide.md#release-rules) and [here](#nowhere)\n",
      "docs/guide.md": "# Guide\n\n## Rules\n",
    });
    expect(checkDocs(root, { files: ["README.md", "docs/guide.md"], budget }).map((problem) => problem.message)).toEqual([
      "docs/guide.md#release-rules names #release-rules, which docs/guide.md does not have",
      "#nowhere names #nowhere, which README.md does not have",
    ]);
  });

  test("accepts links to headings the way GitHub slugs them, including repeats and inline code", () => {
    const root = project({
      "README.md": [
        "[a](docs/guide.md#the-check-docs-script) [b](docs/guide.md#notes-1) [c](docs/guide.md#whats-new)",
        "[d](docs/guide.md#custom) [e](#intro) [f](../README.md) ![logo](docs/logo.png)",
        "[g](https://example.com/x.md) [h](mailto:a@b.c)",
        "",
        "## Intro",
        "",
      ].join("\n"),
      "docs/guide.md": '# The `check-docs` script\n\n## Notes\n\n## Notes\n\n## What\'s new?\n\n<a id="custom"></a>\n',
      "docs/logo.png": "",
    });
    const problems = checkDocs(root, { files: ["README.md", "docs/guide.md"], budget });
    expect(problems).toEqual([{ file: "README.md", line: 2, message: "../README.md points outside the repository" }]);
  });

  test("ignores links inside code fences, inline code and HTML comments", () => {
    const root = project({
      "README.md":
        "```md\n[x](missing.md)\n```\n\nUse `[y](missing.md)` syntax.\n<!-- fill: e.g. [z](missing.md) -->\n<!--\n[w](missing.md)\n-->\n",
    });
    expect(checkDocs(root, { files: ["README.md"], budget })).toEqual([]);
  });

  test("checks reference-style link definitions", () => {
    const root = project({ "README.md": "See [the guide][guide].\n\n[guide]: docs/gone.md\n" });
    expect(checkDocs(root, { files: ["README.md"], budget })).toEqual([
      { file: "README.md", line: 3, message: "docs/gone.md names docs/gone.md, which does not exist" },
    ]);
  });
});

describe("AGENTS.md budget", () => {
  test("allows the root file more lines than a nested one", () => {
    const root = project({ "AGENTS.md": lines(200), "src/api/AGENTS.md": lines(200) });
    expect(checkDocs(root, { files: ["AGENTS.md", "src/api/AGENTS.md"], budget })).toEqual([
      { file: "src/api/AGENTS.md", line: 151, message: "has 200 lines; the budget for a nested AGENTS.md is 150" },
    ]);
  });

  test("reports a root file over its budget", () => {
    const root = project({ "AGENTS.md": lines(301) });
    expect(checkDocs(root, { files: ["AGENTS.md"], budget }).map((problem) => problem.message)).toEqual([
      "has 301 lines; the budget for the root AGENTS.md is 300",
    ]);
  });
});

describe("command line", () => {
  test("reads tracked Markdown files from git and takes budgets from flags", () => {
    const root = project({ "AGENTS.md": lines(20), "README.md": "[ok](AGENTS.md)\n", "untracked.md": "[x](nope.md)\n" });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "AGENTS.md", "README.md"], { cwd: root });

    const passing = spawnSync("node", [SCRIPT, "--root", root], { encoding: "utf8" });
    expect(passing.status).toBe(0);

    const failing = spawnSync("node", [SCRIPT, "--root", root, "--root-budget", "10"], { encoding: "utf8" });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("AGENTS.md:11: has 20 lines; the budget for the root AGENTS.md is 10");
    expect(failing.stderr).not.toContain("untracked.md");
  });
});
