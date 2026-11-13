import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkDocs } from "../../../skills/repo-kit/modules/agent-docs/templates/scripts/check-docs.mts";

const SCRIPT = resolve(import.meta.dirname, "../../../skills/repo-kit/modules/agent-docs/templates/scripts/check-docs.mts");
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

describe("code paths in the AGENTS.md map and ADR Code lines", () => {
  test("reports a backticked path in the Map section of an AGENTS.md that no longer exists", () => {
    const root = project({
      "AGENTS.md": [
        "# Guide",
        "",
        "## Map",
        "",
        "- Billing: `src/billing/` starts at `chargeCard` in `src/billing/charge.ts`.",
        "- Auth: `src/auth/session.ts:42` (`readSession()`), built with `node scripts/build.mts`.",
        "",
        "## Commands",
        "",
        "Run `src/gone.ts` is outside the map, so it is not checked.",
      ].join("\n"),
      "src/billing/index.ts": "",
    });
    expect(checkDocs(root, { files: ["AGENTS.md"], budget })).toEqual([
      { file: "AGENTS.md", line: 5, message: "the map names src/billing/charge.ts, which does not exist" },
      { file: "AGENTS.md", line: 6, message: "the map names src/auth/session.ts, which does not exist" },
    ]);
  });

  test("accepts map paths that exist, from the repository root or the AGENTS.md folder, and skips globs and packages", () => {
    const root = project({
      "packages/api/AGENTS.md":
        "## Map\n\n- Routes: `src/routes.ts`, `packages/api/src/routes.ts`, `src/**/*.test.ts`, `@scope/pkg`, `db.query`, `next/navigation`, `application/json`, `/api/stripe/webhook`, `package.json`\n",
      "packages/api/src/routes.ts": "",
      "packages/api/package.json": "{}",
    });
    expect(checkDocs(root, { files: ["packages/api/AGENTS.md"], budget })).toEqual([]);
  });

  test("ignores the fill placeholder of an unfilled map", () => {
    const root = project({ "AGENTS.md": "## Map\n\n<!-- fill: e.g. `src/billing/charge.ts` -->\n" });
    expect(checkDocs(root, { files: ["AGENTS.md"], budget })).toEqual([]);
  });

  test("reports a missing path on the Code line of an ADR, and only there", () => {
    const root = project({
      "docs/adr/0003-idempotent-charges.md": [
        "# 0003: Idempotent charges",
        "",
        "- Status: Accepted",
        "- Code: `src/billing/charge.ts` (`chargeCard`), `src/billing/ledger.ts`",
        "",
        "We once kept `src/old/payments.ts`, now removed.",
      ].join("\n"),
      "docs/adr/0000-template.md": "# 0000: Title\n\n- Code: <!-- backticked paths: `src/x.ts` (`run`) -->\n",
      "src/billing/charge.ts": "",
    });
    expect(checkDocs(root, { files: ["docs/adr/0003-idempotent-charges.md", "docs/adr/0000-template.md"], budget })).toEqual([
      { file: "docs/adr/0003-idempotent-charges.md", line: 4, message: "the Code line names src/billing/ledger.ts, which does not exist" },
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
