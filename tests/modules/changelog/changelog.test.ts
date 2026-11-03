import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  checkFragments,
  checkPullRequest,
  releaseChangelog,
} from "../../../skills/repo-kit/modules/changelog/templates/scripts/changelog.mts";

const SCRIPT = resolve(import.meta.dirname, "../../../skills/repo-kit/modules/changelog/templates/scripts/changelog.mts");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "changelog-"));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const README = "# Unreleased notes\n\n```md\n### Nonsense\n\n-\n```\n";

describe("fragment check", () => {
  test("accepts groups with bullets, including wrapped bullets, and ignores the README", () => {
    const root = project({
      "changelog.d/README.md": README,
      "changelog.d/feat-export.md":
        "### Added\n\n- Export reports as CSV. Before, only PDF\n  was offered.\n\n### Fixed\n\n- Keep the filter after a reload.\n",
    });
    expect(checkFragments(root)).toEqual([]);
  });

  test("rejects a heading outside the allowed groups, a bullet with no group, and an empty bullet", () => {
    const root = project({
      "changelog.d/a.md": "### Improved\n\n- Faster search.\n",
      "changelog.d/b.md": "- Orphan line.\n\n### Fixed\n\n- \n",
      "changelog.d/c.md": "### Changed\n",
    });
    expect(checkFragments(root)).toEqual([
      'changelog.d/a.md:1: "### Improved" is not a group; use one of Added, Changed, Deprecated, Removed, Fixed, Security',
      "changelog.d/b.md:1: a bullet needs a group heading above it",
      "changelog.d/b.md:5: empty bullet",
      "changelog.d/c.md:1: ### Changed has no bullets",
    ]);
  });
});

describe("release", () => {
  const changelog = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- First release.\n";

  test("folds every fragment into one version section in group order and deletes the fragments", () => {
    const root = project({
      "CHANGELOG.md": changelog,
      "changelog.d/README.md": README,
      "changelog.d/fix-login.md": "### Fixed\n\n- Sign in with a magic link again.\n\n### Added\n\n- Remember the last workspace.\n",
      "changelog.d/feat-export.md":
        "### Security\n\n- Escape CSV cells that start with `=`.\n\n### Added\n\n- Export reports as CSV.\n  Large reports stream.\n",
    });

    const result = releaseChangelog(root, "1.1.0", "2026-11-03");

    expect(result.folded).toEqual(["changelog.d/feat-export.md", "changelog.d/fix-login.md"]);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [1.1.0] - 2026-11-03",
        "",
        "### Added",
        "",
        "- Export reports as CSV.",
        "  Large reports stream.",
        "- Remember the last workspace.",
        "",
        "### Fixed",
        "",
        "- Sign in with a magic link again.",
        "",
        "### Security",
        "",
        "- Escape CSV cells that start with `=`.",
        "",
        "## [1.0.0] - 2026-01-01",
        "",
        "### Added",
        "",
        "- First release.",
        "",
      ].join("\n"),
    );
    expect(existsSync(join(root, "changelog.d/fix-login.md"))).toBe(false);
    expect(existsSync(join(root, "changelog.d/feat-export.md"))).toBe(false);
    expect(existsSync(join(root, "changelog.d/README.md"))).toBe(true);
  });

  test("creates CHANGELOG.md when the project has none", () => {
    const root = project({ "changelog.d/x.md": "### Fixed\n\n- Load the page on Safari.\n" });
    releaseChangelog(root, "0.1.0", "2026-11-03");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toStartWith("# Changelog\n");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(
      "## [0.1.0] - 2026-11-03\n\n### Fixed\n\n- Load the page on Safari.\n",
    );
  });

  test("refuses with no fragments, with an invalid fragment, or with a version already released, and changes nothing", () => {
    const empty = project({ "CHANGELOG.md": changelog, "changelog.d/README.md": README });
    expect(() => releaseChangelog(empty, "1.1.0", "2026-11-03")).toThrow("no release notes in changelog.d");

    const invalid = project({ "CHANGELOG.md": changelog, "changelog.d/x.md": "### Misc\n\n- Something.\n" });
    expect(() => releaseChangelog(invalid, "1.1.0", "2026-11-03")).toThrow('"### Misc" is not a group');
    expect(existsSync(join(invalid, "changelog.d/x.md"))).toBe(true);

    const released = project({ "CHANGELOG.md": changelog, "changelog.d/x.md": "### Fixed\n\n- Something.\n" });
    expect(() => releaseChangelog(released, "1.0.0", "2026-11-03")).toThrow("CHANGELOG.md already has 1.0.0");
    expect(readFileSync(join(released, "CHANGELOG.md"), "utf8")).toBe(changelog);
  });
});

describe("pull request check", () => {
  test("passes when the pull request adds a fragment or changes CHANGELOG.md", () => {
    expect(checkPullRequest({ changedFiles: ["src/a.ts", "changelog.d/feat-x.md"], labels: [] })).toBeNull();
    expect(checkPullRequest({ changedFiles: ["CHANGELOG.md"], labels: [] })).toBeNull();
  });

  test("fails without a fragment, naming the file to write, unless the no-changelog label is set", () => {
    const changedFiles = ["src/a.ts", "changelog.d/README.md"];
    expect(checkPullRequest({ changedFiles, labels: [], branch: "feat/csv-export" })).toContain("changelog.d/feat-csv-export.md");
    expect(checkPullRequest({ changedFiles, labels: ["no-changelog"] })).toBeNull();
  });

  test("the command line diffs against the base revision and reads labels as JSON", () => {
    const root = project({ "README.md": "x\n", "changelog.d/README.md": README });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "base", "--allow-empty");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base files");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "src.ts"), "export {};\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "code only");

    const run = (...args: string[]) => spawnSync("node", [SCRIPT, "check", "--root", root, ...args], { encoding: "utf8" });
    expect(run("--base", base).status).toBe(1);
    expect(run("--base", base, "--labels", '["bug","no-changelog"]').status).toBe(0);

    writeFileSync(join(root, "changelog.d/code-only.md"), "### Added\n\n- A source file.\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "notes");
    expect(run("--base", base).status).toBe(0);
  });
});
