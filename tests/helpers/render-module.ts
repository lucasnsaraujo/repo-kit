import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execute, plan } from "../../skill/scripts/lib/apply.ts";
import { detect } from "../../skill/scripts/lib/detect.ts";
import { loadModules } from "../../skill/scripts/lib/modules.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

export type Lockfile = "bun.lock" | "pnpm-lock.yaml";

const temps: string[] = [];

export function removeTempDirs(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix = "repo-kit-module-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * Applies the given modules (and what they require) to a fresh project through the real engine.
 * Only the listed module folders are copied, so a half-built module elsewhere cannot break the run.
 */
export function applyModules(input: {
  lockfile: Lockfile;
  modules: string[];
  copy?: string[];
  packageJson?: Record<string, unknown>;
  linkNodeModules?: boolean;
}): string {
  const project = tempDir();
  writeFileSync(join(project, input.lockfile), "");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "demo", private: true, type: "module", ...input.packageJson }, null, 2),
  );
  const modulesDir = tempDir("repo-kit-modules-");
  for (const id of input.copy ?? input.modules) cpSync(join(REPO_ROOT, "skill/modules", id), join(modulesDir, id), { recursive: true });
  const result = plan({ root: project, detection: detect(project), modules: loadModules(modulesDir), requested: input.modules });
  execute(project, result);
  if (input.linkNodeModules) symlinkSync(join(REPO_ROOT, "node_modules"), join(project, "node_modules"));
  return project;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}
