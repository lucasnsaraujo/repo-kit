import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildVars } from "../../../skills/repo-kit/scripts/lib/apply.ts";
import { detect } from "../../../skills/repo-kit/scripts/lib/detect.ts";
import { renderTemplate } from "../../../skills/repo-kit/scripts/lib/render.ts";
import { applyModules, REPO_ROOT, removeTempDirs, tempDir, writeFiles } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

const HOOKS = [".githooks/pre-commit", ".githooks/pre-push"];

describe("rendered hooks", () => {
  for (const lockfile of ["bun.lock", "pnpm-lock.yaml"] as const) {
    test(`parse as POSIX sh and are executable for ${lockfile}, with every optional step rendered`, () => {
      const project = applyModules({ lockfile, modules: ["hooks", "tests"], copy: ["hooks", "quality", "tests"] });
      const vars = buildVars(detect(project), ["quality", "hooks", "tests", "supply-chain"]);
      for (const hook of HOOKS) {
        expect(statSync(join(project, hook)).mode & 0o111).not.toBe(0);
        const full = renderTemplate(readFileSync(join(REPO_ROOT, "skills/repo-kit/modules/hooks/templates", hook), "utf8"), vars);
        for (const source of [readFileSync(join(project, hook), "utf8"), full]) {
          expect(spawnSync("sh", ["-n"], { input: source, encoding: "utf8" }).stderr).toBe("");
        }
      }
    });
  }

  test("pre-push is left out when the tests module is not selected", () => {
    const project = applyModules({ lockfile: "bun.lock", modules: ["hooks"], copy: ["hooks", "quality"] });
    expect(existsSync(join(project, ".githooks/pre-commit"))).toBe(true);
    expect(existsSync(join(project, ".githooks/pre-push"))).toBe(false);
  });
});

describe("pre-commit in a real repository", () => {
  // Stand-ins for the real tools: the fixer appends a line to each staged file, as a formatter
  // would rewrite it, and the checks leave a marker file behind so the test sees they ran.
  const scripts = {
    "check:staged": "node fixer.mjs",
    typecheck: "node -e \"require('node:fs').writeFileSync('.ran-typecheck', '')\"",
    knip: "node -e \"require('node:fs').writeFileSync('.ran-knip', '')\"",
  };
  const fixer = `import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" }).split("\\n").filter(Boolean);
for (const file of staged) appendFileSync(file, "fixed\\n");
`;

  function setupRepo() {
    const project = applyModules({ lockfile: "bun.lock", modules: ["hooks"], copy: ["hooks", "quality"], packageJson: { scripts } });
    writeFiles(project, { "fixer.mjs": fixer, ".gitignore": ".ran-*\n", "src/a.ts": "export const a = 1;\n", "README.md": "# demo\n" });
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "base", "--no-verify");
    const prepare = spawnSync("bun", ["run", "prepare"], { cwd: project, encoding: "utf8" });
    expect(prepare.status).toBe(0);
    expect(git("config", "core.hooksPath").stdout.trim()).toBe(".githooks");
    const committed = (path: string) => git("show", `HEAD:${path}`).stdout;
    const ran = (check: string) => existsSync(join(project, `.ran-${check}`));
    return { project, git, committed, ran };
  }

  test("re-stages the fixer's edits to fully staged files and typechecks staged TypeScript", () => {
    const repo = setupRepo();
    writeFiles(repo.project, { "src/a.ts": "export const a = 2;\n" });
    repo.git("add", "src/a.ts");
    const commit = repo.git("commit", "-qm", "change a");
    expect(commit.status).toBe(0);
    expect(repo.committed("src/a.ts")).toBe("export const a = 2;\nfixed\n");
    expect(repo.ran("typecheck")).toBe(true);
    expect(repo.ran("knip")).toBe(false);
  });

  test("stops the commit when the fixer changes a file that also has unstaged edits", () => {
    const repo = setupRepo();
    writeFiles(repo.project, { "src/a.ts": "export const a = 2;\n" });
    repo.git("add", "src/a.ts");
    writeFiles(repo.project, { "src/a.ts": "export const a = 2;\nexport const unstaged = true;\n" });
    const commit = repo.git("commit", "-qm", "change a");
    expect(commit.status).toBe(1);
    expect(commit.stderr).toContain("  src/a.ts");
    expect(repo.committed("src/a.ts")).toBe("export const a = 1;\n");
    expect(repo.git("diff", "--cached").stdout).toContain("+export const a = 2;");
    expect(repo.git("diff", "--cached").stdout).not.toContain("fixed");
  });

  test("skips the typecheck for a docs-only commit and runs knip when package.json changes", () => {
    const repo = setupRepo();
    writeFiles(repo.project, { "README.md": "# demo\n\nMore.\n" });
    repo.git("add", "README.md");
    expect(repo.git("commit", "-qm", "docs").status).toBe(0);
    expect(repo.ran("typecheck")).toBe(false);

    const pkg = JSON.parse(readFileSync(join(repo.project, "package.json"), "utf8"));
    writeFiles(repo.project, { "package.json": `${JSON.stringify({ ...pkg, version: "1.0.0" }, null, 2)}\n` });
    repo.git("add", "package.json");
    expect(repo.git("commit", "-qm", "version").status).toBe(0);
    expect(repo.ran("knip")).toBe(true);
    expect(repo.ran("typecheck")).toBe(true);
  });
});

test("pre-push lets the push through when origin has no default branch to compare against", () => {
  const project = applyModules({ lockfile: "bun.lock", modules: ["hooks", "tests"], copy: ["hooks", "quality", "tests"] });
  execFileSync("git", ["init", "-q"], { cwd: project });
  const push = spawnSync("sh", [".githooks/pre-push"], { cwd: project, encoding: "utf8" });
  expect(push.status).toBe(0);
  expect(push.stdout).toContain("CI runs the tests");
});

test("the prepare script does nothing outside a git checkout", () => {
  const project = applyModules({ lockfile: "bun.lock", modules: ["hooks"], copy: ["hooks", "quality"] });
  const outside = tempDir();
  writeFiles(outside, { "package.json": readFileSync(join(project, "package.json"), "utf8") });
  const prepare = spawnSync("bun", ["run", "prepare"], {
    cwd: outside,
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: outside },
  });
  expect(prepare.status).toBe(0);
});
