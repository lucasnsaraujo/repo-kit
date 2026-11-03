import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentDocPaths,
  capSections,
  chooseScope,
  diffSection,
  matchesGlob,
  parseRule,
  selectRules,
} from "../../../skill/modules/ai-review/templates/.github/ai-review/compose-prompt.ts";

describe("glob matching", () => {
  test.each([
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "src/deep/a.test.ts", true],
    ["**/*.test.ts", "src/a.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/nested/a.ts", false],
    ["migrations/**", "migrations/2026/001.sql", true],
    ["**/*.{ts,tsx}", "app/page.tsx", true],
    ["**/.env*", ".env.production", true],
    ["file?.md", "file1.md", true],
    ["a.b", "axb", false],
  ])("%s against %s is %p", (glob, path, expected) => {
    expect(matchesGlob(glob, path)).toBe(expected);
  });
});

describe("domain rules", () => {
  const tests = parseRule("rules/tests.md", '---\ninclude:\n  - "**/*.test.ts"\n  - tests/**\n---\n\n## Tests\n\nReport when...\n');
  const sql = parseRule("rules/sql.md", "---\ninclude:\n  - '**/*.sql'\n---\n## SQL\n");

  test("front matter globs are parsed and the body follows it", () => {
    expect(tests.include).toEqual(["**/*.test.ts", "tests/**"]);
    expect(tests.body).toBe("## Tests\n\nReport when...");
  });

  test("a rule without include globs is rejected", () => {
    expect(() => parseRule("rules/empty.md", "---\ninclude:\n---\nbody")).toThrow("include");
    expect(() => parseRule("rules/none.md", "## no front matter")).toThrow("front matter");
  });

  test("every shipped rule parses and applies to the files it is written for", () => {
    const directory = join(import.meta.dir, "../../../skill/modules/ai-review/templates/.github/ai-review/rules");
    const shipped = readdirSync(directory).map((name) => parseRule(name, readFileSync(join(directory, name), "utf8")));
    const pick = (file: string) => selectRules(shipped, [file]).map((rule) => rule.path);
    expect(pick("src/user.test.ts")).toEqual(["tests.md"]);
    expect(pick("src/api/routes/login.ts")).toEqual(["security.md"]);
    expect(pick(".github/workflows/ci.yml")).toEqual(["security.md"]);
    expect(pick("db/migrations/0042_add_index.sql")).toEqual(["migrations.md"]);
    expect(pick("README.md")).toEqual([]);
  });

  test("only rules whose globs match a changed file are selected", () => {
    expect(selectRules([tests, sql], ["src/a.ts", "src/a.test.ts"]).map((rule) => rule.path)).toEqual(["rules/tests.md"]);
    expect(selectRules([tests, sql], ["README.md"])).toEqual([]);
  });
});

describe("repository instructions", () => {
  test("collects the root AGENTS.md and the one in every ancestor directory of a changed file, root first", () => {
    const existing = new Set(["AGENTS.md", "packages/AGENTS.md", "packages/api/AGENTS.md", "packages/web/AGENTS.md", "docs/AGENTS.md"]);
    expect(agentDocPaths(["packages/api/src/routes/user.ts", "README.md"], existing)).toEqual([
      "AGENTS.md",
      "packages/AGENTS.md",
      "packages/api/AGENTS.md",
    ]);
  });

  test("sections past the byte cap are cut with a note naming what was left out", () => {
    const text = capSections(
      [
        { heading: "AGENTS.md", body: "a".repeat(60) },
        { heading: "packages/AGENTS.md", body: "b".repeat(60) },
      ],
      100,
    );
    expect(text).toContain("a".repeat(60));
    expect(text).not.toContain("b".repeat(60));
    expect(text).toContain("truncated");
    expect(text).toContain("packages/AGENTS.md");
  });
});

describe("review scope", () => {
  const base = "b".repeat(40);
  const reviewed = "r".repeat(40);
  const head = "h".repeat(40);
  const history = new Set([`${reviewed}>${head}`, `${base}>${reviewed}`, `${base}>${head}`]);
  const isAncestor = (ancestor: string, descendant: string) => ancestor === descendant || history.has(`${ancestor}>${descendant}`);

  test("reviews only the new commits when the last reviewed commit sits between base and head", () => {
    expect(chooseScope({ baseSha: base, headSha: head, reviewedSha: reviewed, isAncestor })).toEqual({
      kind: "since",
      reviewedSha: reviewed,
    });
  });

  test("falls back to the full PR without a previous review, after a force-push, or after the base moved past it", () => {
    expect(chooseScope({ baseSha: base, headSha: head, reviewedSha: null, isAncestor })).toEqual({ kind: "full" });
    expect(chooseScope({ baseSha: base, headSha: head, reviewedSha: "f".repeat(40), isAncestor })).toEqual({ kind: "full" });
    const newBase = "n".repeat(40);
    const rebased = (ancestor: string, descendant: string) =>
      isAncestor(ancestor, descendant) || (ancestor === newBase && descendant === head);
    expect(chooseScope({ baseSha: newBase, headSha: head, reviewedSha: reviewed, isAncestor: rebased })).toEqual({ kind: "full" });
  });
});

describe("diff section", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+const fence = '```';\n";

  test("inlines a diff under the limit inside a fence longer than any backtick run in it", () => {
    const section = diffSection({ diff, files: ["src/a.ts"], command: "git diff b...h", limitBytes: 10_000 });
    expect(section).toContain(diff);
    expect(section).toContain("````diff\n");
  });

  test("lists the files to read one at a time when the diff is over the limit", () => {
    const section = diffSection({ diff, files: ["src/a.ts", "src/b.ts"], command: "git diff b...h", limitBytes: 10 });
    expect(section).not.toContain("const fence");
    expect(section).toContain("- src/a.ts\n- src/b.ts");
    expect(section).toContain("git diff b...h -- <path>");
  });
});
