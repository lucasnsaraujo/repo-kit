import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adopt, check, execute, NEW_SUFFIX, plan, readLock, remove } from "../skill/scripts/lib/apply.ts";
import { detect } from "../skill/scripts/lib/detect.ts";
import { loadModules } from "../skill/scripts/lib/modules.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-kit-"));
  temps.push(dir);
  return dir;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function setup(lockfile = "bun.lock") {
  const project = tempDir();
  write(project, "package.json", JSON.stringify({ name: "demo", private: true, scripts: { lint: "eslint ." } }, null, 2));
  write(project, lockfile, "");
  const modulesDir = tempDir();
  write(modulesDir, "base/module.json", JSON.stringify({ id: "base", summary: "base files", files: [{ path: "BASE.md" }] }));
  write(modulesDir, "base/templates/BASE.md", "run {%pmRun%} test\n");
  write(
    modulesDir,
    "ci/module.json",
    JSON.stringify({
      id: "ci",
      summary: "ci",
      requires: ["base"],
      files: [
        { path: ".github/workflows/ci.yml" },
        { path: "bunfig.toml", when: "bun" },
        { path: ".githooks/pre-commit", executable: true },
      ],
      symlinks: [{ path: ".claude/skills", target: "../.agents/skills" }],
      packageScripts: { lint: "biome check .", "test:changed": "{%pmRun%} vitest --changed" },
      packageFields: { trustedDependencies: [] },
      lines: [{ path: ".gitignore", lines: [".env.keys", "node_modules"] }],
      devDependencies: ["@biomejs/biome"],
    }),
  );
  write(modulesDir, "ci/templates/.github/workflows/ci.yml", "{%if module:base%}\nbase: yes\n{%endif%}\nbranch: {%defaultBranch%}\n");
  write(modulesDir, "ci/templates/bunfig.toml", "[install]\nexact = true\n");
  write(modulesDir, "ci/templates/.githooks/pre-commit", "#!/bin/sh\n");
  write(project, ".gitignore", "node_modules\n");
  const modules = loadModules(modulesDir);
  const run = (requested: string[]) => {
    const result = plan({ root: project, detection: detect(project), modules, requested });
    execute(project, result);
    return result;
  };
  return { project, modulesDir, modules, run };
}

const kinds = (result: ReturnType<typeof plan>) =>
  result.actions.map((action) => `${action.kind}:${"path" in action ? action.path : "name" in action ? action.name : action.key}`);

describe("plan and execute", () => {
  test("first run writes every file, pulls in required modules, and records hashes", () => {
    const { project, run } = setup();
    const result = run(["ci"]);

    expect(result.modules).toEqual(["base", "ci"]);
    expect(result.addedFor).toEqual({ base: "ci" });
    expect(read(project, "BASE.md")).toBe("run bun run test\n");
    expect(read(project, ".github/workflows/ci.yml")).toBe("base: yes\nbranch: main\n");
    expect(readlinkSync(join(project, ".claude/skills"))).toBe("../.agents/skills");
    expect(result.installCommand).toBe("bun add -d --exact @biomejs/biome");
    expect(Object.keys(readLock(project)?.files ?? {})).toEqual([
      ".githooks/pre-commit",
      ".github/workflows/ci.yml",
      "BASE.md",
      "bunfig.toml",
    ]);
  });

  test("adds missing scripts, fields and lines but reports a script that already differs", () => {
    const { project, run } = setup();
    const result = run(["ci"]);
    const pkg = JSON.parse(read(project, "package.json"));

    expect(pkg.scripts).toEqual({ lint: "eslint .", "test:changed": "bun run vitest --changed" });
    expect(pkg.trustedDependencies).toEqual([]);
    expect(read(project, ".gitignore")).toBe("node_modules\n.env.keys\n");
    expect(kinds(result)).toContain("script-conflict:lint");
  });

  test("skips files whose condition does not hold", () => {
    const { project, run } = setup("pnpm-lock.yaml");
    run(["ci"]);
    expect(existsSync(join(project, "bunfig.toml"))).toBe(false);
    expect(read(project, "BASE.md")).toBe("run pnpm run test\n");
  });

  test("a second run with nothing changed writes nothing new", () => {
    const { run } = setup();
    run(["ci"]);
    const second = run([]);
    expect(second.modules).toEqual(["base", "ci"]);
    expect(
      second.actions.filter((action) => action.kind !== "unchanged" && action.kind !== "symlink" && action.kind !== "script-conflict"),
    ).toEqual([]);
  });

  test("updates an untouched file when the template changes", () => {
    const { project, modulesDir, run } = setup();
    run(["base"]);
    write(modulesDir, "base/templates/BASE.md", "v2 {%pm%}\n");
    run([]);
    expect(read(project, "BASE.md")).toBe("v2 bun\n");
  });

  test("never overwrites a file the user edited: the new version lands beside it", () => {
    const { project, modulesDir, run } = setup();
    run(["base"]);
    write(project, "BASE.md", "my own text\n");
    write(modulesDir, "base/templates/BASE.md", "v2\n");
    const result = run([]);

    expect(read(project, "BASE.md")).toBe("my own text\n");
    expect(read(project, `BASE.md${NEW_SUFFIX}`)).toBe("v2\n");
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "conflict", path: "BASE.md", reason: "edited" }));
  });

  test("never overwrites a file that existed before the kit", () => {
    const { project, run } = setup();
    write(project, "BASE.md", "pre-existing\n");
    run(["base"]);
    expect(read(project, "BASE.md")).toBe("pre-existing\n");
    expect(existsSync(join(project, `BASE.md${NEW_SUFFIX}`))).toBe(true);
  });
});

describe("adopt, check and remove", () => {
  test("an adopted file keeps its content across template updates and clears the proposal", () => {
    const { project, modulesDir, modules, run } = setup();
    write(project, "BASE.md", "pre-existing\n");
    run(["base"]);
    adopt(project, ["BASE.md"], modules);
    expect(existsSync(join(project, `BASE.md${NEW_SUFFIX}`))).toBe(false);

    write(modulesDir, "base/templates/BASE.md", "v2\n");
    const result = run([]);
    expect(read(project, "BASE.md")).toBe("pre-existing\n");
    expect(result.actions).toContainEqual(expect.objectContaining({ kind: "conflict", path: "BASE.md", reason: "adopted" }));
  });

  test("check reports edited, missing and outdated files", () => {
    const { project, modulesDir, modules, run } = setup();
    run(["ci"]);
    write(project, "BASE.md", "edited\n");
    rmSync(join(project, "bunfig.toml"));
    write(modulesDir, "ci/templates/.githooks/pre-commit", "#!/bin/sh\necho v2\n");

    const drift = check({ root: project, detection: detect(project), modules });
    expect(drift).toEqual([
      { path: ".githooks/pre-commit", state: "outdated" },
      { path: "BASE.md", state: "edited" },
      { path: "bunfig.toml", state: "missing" },
    ]);
  });

  test("remove deletes untouched files, keeps edited ones, and refuses while another module needs it", () => {
    const { project, modules, run } = setup();
    run(["ci"]);
    expect(() => remove(project, "base", modules)).toThrow("required by ci");

    write(project, "bunfig.toml", "edited\n");
    const result = remove(project, "ci", modules);
    expect(result.deleted.sort()).toEqual([".githooks/pre-commit", ".github/workflows/ci.yml"]);
    expect(result.kept).toEqual(["bunfig.toml"]);
    expect(readLock(project)?.modules).toEqual(["base"]);
  });

  test("remove drops the module's untouched scripts and re-renders files that mentioned it", () => {
    const { project, modulesDir, modules, run } = setup();
    write(modulesDir, "base/templates/BASE.md", "{%if module:ci%}\nci is on\n{%endif%}\nrun {%pmRun%} test\n");
    run(["ci"]);
    expect(read(project, "BASE.md")).toBe("ci is on\nrun bun run test\n");

    remove(project, "ci", modules);
    const pkg = JSON.parse(read(project, "package.json"));
    expect(pkg.scripts).toEqual({ lint: "eslint ." });
    expect(read(project, "BASE.md")).toBe("run bun run test\n");
  });

  test("refuses package managers it has no templates for", () => {
    const { modules } = setup();
    const project = tempDir();
    write(project, "package.json", "{}");
    write(project, "package-lock.json", "{}");
    expect(() => plan({ root: project, detection: detect(project), modules, requested: ["base"] })).toThrow("supports bun and pnpm");
  });
});
