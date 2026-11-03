import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "../skill/scripts/lib/detect.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "repo-kit-detect-"));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  return root;
}

describe("detect", () => {
  test("a pnpm-workspace.yaml that only holds settings is not a monorepo", () => {
    const root = project({ "package.json": "{}", "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "minimumReleaseAge: 4320\n" });
    expect(detect(root).monorepo).toBe(false);
  });

  test("a pnpm-workspace.yaml with packages is a monorepo", () => {
    const root = project({ "package.json": "{}", "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "packages:\n  - apps/*\n" });
    expect(detect(root).monorepo).toBe(true);
  });

  test("reads the package manager from the lockfile and node from .nvmrc", () => {
    const root = project({ "package.json": "{}", "bun.lock": "", ".nvmrc": "v22\n" });
    const result = detect(root);
    expect(result.packageManager).toBe("bun");
    expect(result.nodeVersion).toBe("22");
  });
});
