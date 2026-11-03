import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ReviewContext } from "../../../skill/modules/ai-review/templates/.github/ai-review/collect.ts";
import {
  agentDocPaths,
  capSections,
  chooseScope,
  compose,
  diffSection,
  matchesGlob,
  parseRule,
  selectRules,
} from "../../../skill/modules/ai-review/templates/.github/ai-review/compose-prompt.ts";
import type { ReviewState } from "../../../skill/modules/ai-review/templates/.github/ai-review/state.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-"));
  temps.push(dir);
  return dir;
}

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
  test("falls back to the full PR without a previous review or after a force-push", () => {
    const forkPoint = "b".repeat(40);
    const head = "h".repeat(40);
    const isAncestor = (ancestor: string, descendant: string) => ancestor === descendant || (ancestor === forkPoint && descendant === head);
    expect(chooseScope({ forkPoint, headSha: head, reviewedSha: null, isAncestor })).toEqual({ kind: "full" });
    expect(chooseScope({ forkPoint, headSha: head, reviewedSha: "f".repeat(40), isAncestor })).toEqual({ kind: "full" });
  });
});

describe("diff section", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+const fence = '```';\n";

  test("inlines a diff under the limit inside a fence longer than any backtick run in it", () => {
    const section = diffSection({ diff, files: ["src/a.ts"], perFileDir: "/review/pr", limitBytes: 10_000 });
    expect(section).toContain(diff);
    expect(section).toContain("````diff\n");
  });

  test("points to the per-file diffs, one at a time, when the diff is over the limit", () => {
    const section = diffSection({ diff, files: ["src/a.ts", "src/b.ts"], perFileDir: "/review/pr", limitBytes: 10 });
    expect(section).not.toContain("const fence");
    expect(section).toContain("- `/review/pr/src/a.ts.diff`\n- `/review/pr/src/b.ts.diff`");
  });
});

describe("composing from a repository", () => {
  function repository() {
    const dir = tempDir();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
    git("init", "-q", "-b", "main");
    const commit = (files: Record<string, string>, message: string) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    return { dir, git, commit };
  }

  function context(reviewedSha: string | null): ReviewContext {
    const previous: ReviewState | null = reviewedSha ? { version: 1, reviewedSha, active: [], withdrawn: [] } : null;
    return {
      title: "t",
      body: "",
      previous: previous ? { commentId: 1, createdAt: "2026-01-01T00:00:00Z", state: previous } : null,
      responses: [],
      omittedResponses: 0,
      readAt: "2026-01-01T00:00:00Z",
    };
  }

  /** main: fork point, then moves on. pr: a reviewed commit, then one more. */
  function reviewedBranch() {
    const repo = repository();
    repo.commit({ "src/a.ts": "one\n" }, "fork point");
    repo.git("checkout", "-q", "-b", "pr");
    const reviewed = repo.commit({ "src/a.ts": "two\n" }, "reviewed");
    repo.git("checkout", "-q", "main");
    const movedBase = repo.commit({ "docs/b.md": "main moved\n" }, "main moved");
    repo.git("checkout", "-q", "pr");
    const head = repo.commit({ "src/a.ts": "three\n" }, "after the review");
    return { ...repo, reviewed, movedBase, head };
  }

  test("reviews only the new commits when the base branch moved on after the last review", () => {
    const { dir, reviewed, movedBase, head } = reviewedBranch();
    const { meta } = compose({ repoDir: dir, base: movedBase, head, context: context(reviewed), filesDir: tempDir() });
    expect(meta.scope).toEqual({ kind: "since", reviewedSha: reviewed });
  });

  test("reviews the whole pull request again once the base branch is merged into it", () => {
    const { dir, git, reviewed, movedBase } = reviewedBranch();
    git("merge", "-q", "--no-edit", "main");
    const head = git("rev-parse", "HEAD");
    const { meta } = compose({ repoDir: dir, base: movedBase, head, context: context(reviewed), filesDir: tempDir() });
    expect(meta.scope).toEqual({ kind: "full" });
  });

  test("writes each changed file's diff and its fork-point version where the reviewer can read them", () => {
    const { dir, reviewed, movedBase, head } = reviewedBranch();
    const filesDir = tempDir();
    const { systemPrompt } = compose({ repoDir: dir, base: movedBase, head, context: context(reviewed), filesDir });
    expect(readFileSync(join(filesDir, "pr/src/a.ts.diff"), "utf8")).toContain("-one\n+three");
    expect(readFileSync(join(filesDir, "since/src/a.ts.diff"), "utf8")).toContain("-two\n+three");
    expect(readFileSync(join(filesDir, "base/src/a.ts"), "utf8")).toBe("one\n");
    expect(existsSync(join(filesDir, "pr/docs/b.md.diff"))).toBe(false);
    expect(systemPrompt).toContain(join(filesDir, "pr"));
    expect(systemPrompt).toContain(join(filesDir, "since"));
  });

  test("a .gitattributes added by the pull request cannot hide its diff as binary", () => {
    const { dir, git, commit } = repository();
    const base = commit({ "src/a.ts": "export const a = 1;\n" }, "base");
    git("checkout", "-q", "-b", "pr");
    const head = commit({ "src/a.ts": "export const a = 2;\n", ".gitattributes": "* -diff\n" }, "hide the diff");
    const filesDir = tempDir();
    const { userMessage } = compose({ repoDir: dir, base, head, context: context(null), filesDir });
    expect(userMessage).toContain("+export const a = 2;");
    expect(userMessage).not.toContain("Binary files");
    expect(readFileSync(join(filesDir, "pr/src/a.ts.diff"), "utf8")).toContain("+export const a = 2;");
  });
});
