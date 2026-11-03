import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execute, plan } from "../../../skill/scripts/lib/apply.ts";
import { detect } from "../../../skill/scripts/lib/detect.ts";
import { type LoadedModule, loadModules } from "../../../skill/scripts/lib/modules.ts";

const MODULES_DIR = resolve(import.meta.dirname, "../../../skill/modules");
const OWN_MODULES = ["agent-docs", "agent-loops", "env", "supply-chain", "changelog"];

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** These five modules plus an empty `ai-review`, so the test does not depend on another module's templates. */
function ownModules(): Map<string, LoadedModule> {
  const all = loadModules(MODULES_DIR);
  const modules = new Map([...all].filter(([id]) => OWN_MODULES.includes(id)));
  modules.set("ai-review", {
    id: "ai-review",
    summary: "stub",
    dir: MODULES_DIR,
    requires: [],
    files: [],
    symlinks: [],
    packageScripts: {},
    packageFields: {},
    lines: [],
    devDependencies: [],
  });
  return modules;
}

function renderInto(lockfile: "bun.lock" | "pnpm-lock.yaml", requested = OWN_MODULES) {
  const root = mkdtempSync(join(tmpdir(), "repo-kit-render-"));
  temps.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", private: true, type: "commonjs", scripts: {} }, null, 2));
  writeFileSync(join(root, lockfile), "");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const result = plan({ root, detection: detect(root), modules: ownModules(), requested });
  execute(root, result);
  const written = result.actions.flatMap((action) => (action.kind === "create" ? [action.path] : []));
  return { root, result, written };
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

describe.each(["bun.lock", "pnpm-lock.yaml"] as const)("rendering the modules into a %s project", (lockfile) => {
  test("writes every file with no template tag left and wires scripts, ignores and the skills link", () => {
    const { root, result, written } = renderInto(lockfile);
    const conflicts = result.actions.filter((action) => action.kind.endsWith("conflict"));
    expect(conflicts).toEqual([]);
    for (const path of written) expect(read(root, path)).not.toMatch(/\{%/);

    const pkg = JSON.parse(read(root, "package.json"));
    expect(Object.keys(pkg.scripts).sort()).toEqual(["changelog:check", "changelog:release", "check:docs", "env:encrypt"]);
    expect(read(root, ".gitignore")).toBe(".env.keys\n");
    expect(read(root, ".worktreeinclude")).toBe(".env.keys\n");
    expect(readlinkSync(join(root, ".claude/skills"))).toBe("../.agents/skills");
    expect(existsSync(join(root, ".claude/skills/ship/SKILL.md"))).toBe(true);
    expect(result.installCommand).toContain("@dotenvx/dotenvx");

    const pm = lockfile === "bun.lock" ? "bun" : "pnpm";
    expect(existsSync(join(root, "bunfig.toml"))).toBe(pm === "bun");
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(pm === "pnpm");
    expect(read(root, ".github/dependabot.yml")).toContain(`package-ecosystem: ${pm === "bun" ? "bun" : "npm"}`);
    expect(read(root, "AGENTS.md")).toContain(`${pm} run check:docs`);
  });

  test("the rendered docs pass check-docs and the rendered workflows pass actionlint", () => {
    const { root } = renderInto(lockfile);
    execFileSync("git", ["add", "-A"], { cwd: root });

    const docs = spawnSync("node", [join(root, "scripts/check-docs.mts"), "--root", root], { encoding: "utf8" });
    expect(docs.stderr).toBe("");
    expect(docs.status).toBe(0);

    const lint = spawnSync("actionlint", [".github/workflows/changelog.yml"], { cwd: root, encoding: "utf8" });
    expect(lint.stdout).toBe("");
    expect(lint.status).toBe(0);
  });

  test("the rendered YAML and TOML files parse", () => {
    const { root } = renderInto(lockfile);
    const dependabot = Bun.YAML.parse(read(root, ".github/dependabot.yml"));
    expect(dependabot).toMatchObject({ version: 2 });
    if (lockfile === "pnpm-lock.yaml") expect(Bun.YAML.parse(read(root, "pnpm-workspace.yaml"))).toMatchObject({ minimumReleaseAge: 4320 });
    else expect(Bun.TOML.parse(read(root, "bunfig.toml"))).toMatchObject({ install: { exact: true, minimumReleaseAge: 259200 } });
  });
});

test("the changelog fragment written by the README example passes the check", () => {
  const { root } = renderInto("bun.lock");
  mkdirSync(join(root, "changelog.d"), { recursive: true });
  const example = /```md\n([\s\S]*?)```/.exec(read(root, "changelog.d/README.md"))?.[1] ?? "";
  writeFileSync(join(root, "changelog.d/fix-empty-search.md"), example);
  const run = spawnSync("node", [join(root, "scripts/changelog.mts"), "check", "--root", root], { encoding: "utf8" });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
});

describe("text that belongs to another module", () => {
  const noChangelog = "no-changelog";

  test("disappears when that module is not selected", () => {
    const { root } = renderInto("bun.lock", ["agent-loops", "env", "supply-chain"]);
    expect(read(root, "AGENTS.md")).not.toContain("changelog.d");
    expect(read(root, ".agents/skills/ship/SKILL.md")).not.toContain(noChangelog);
    expect(read(root, ".github/dependabot.yml")).not.toContain(noChangelog);
    expect(read(root, ".agents/skills/ship/SKILL.md")).not.toContain("All checks pass");
  });

  test("labels every Dependabot pull request no-changelog when the changelog check runs", () => {
    const { root } = renderInto("pnpm-lock.yaml");
    const config = Bun.YAML.parse(read(root, ".github/dependabot.yml"));
    const updates: { labels?: string[] }[] =
      typeof config === "object" && config !== null && "updates" in config && Array.isArray(config.updates) ? config.updates : [];
    expect(updates.map((update) => update.labels)).toEqual([
      ["dependencies", noChangelog],
      ["dependencies", noChangelog],
    ]);
  });
});
