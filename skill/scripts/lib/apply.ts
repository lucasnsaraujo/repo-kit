import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Detection, PackageJson } from "./detect.ts";
import { readPackageJson } from "./detect.ts";
import type { LoadedModule } from "./modules.ts";
import { resolveSelection } from "./modules.ts";
import { renderTemplate, type TemplateVars } from "./render.ts";
import { KIT_VERSION } from "./version.ts";

export const LOCK_FILE = ".repo-kit.json";
export const NEW_SUFFIX = ".repo-kit-new";

export type LockEntry = { module: string; sha256: string; adopted?: boolean };
export type Lock = { kitVersion: string; modules: string[]; files: Record<string, LockEntry> };

export type ConflictReason = "unmanaged" | "edited" | "adopted";

export type Action =
  | { kind: "create" | "update" | "unchanged"; path: string; module: string; content: string; executable: boolean }
  | { kind: "conflict"; path: string; module: string; content: string; reason: ConflictReason }
  | { kind: "symlink"; path: string; target: string; module: string }
  | { kind: "symlink-conflict"; path: string; target: string; module: string }
  | { kind: "script"; name: string; command: string; module: string }
  | { kind: "script-conflict"; name: string; command: string; existing: string; module: string }
  | { kind: "field"; key: string; value: unknown; module: string }
  | { kind: "line"; path: string; line: string; module: string };

export type Plan = {
  modules: string[];
  addedFor: Record<string, string>;
  actions: Action[];
  devDependencies: string[];
  installCommand: string | null;
};

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function readLock(root: string): Lock | null {
  const path = join(root, LOCK_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function writeLock(root: string, lock: Lock): void {
  const files = Object.fromEntries(Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify({ ...lock, files }, null, 2)}\n`);
}

export function buildVars(detection: Detection, modules: string[]): TemplateVars {
  const pm = detection.packageManager;
  if (pm !== "bun" && pm !== "pnpm") {
    throw new Error(`repo-kit supports bun and pnpm projects; this one uses ${pm ?? "no package manager"}`);
  }
  const vars: TemplateVars = {
    pm,
    bun: pm === "bun",
    pnpm: pm === "pnpm",
    pmRun: `${pm} run`,
    pmExec: pm === "bun" ? "bunx" : "pnpm exec",
    installFrozen: `${pm} install --frozen-lockfile`,
    defaultBranch: detection.defaultBranch,
    nodeVersion: detection.nodeVersion,
    monorepo: detection.monorepo,
    library: detection.isLibrary,
  };
  for (const id of modules) vars[`module:${id}`] = true;
  return vars;
}

function conditionHolds(condition: string | undefined, vars: TemplateVars): boolean {
  if (!condition) return true;
  return renderTemplate(`{%if ${condition}%}\nyes\n{%endif%}`, vars) === "yes";
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function fileAction(root: string, module: LoadedModule, path: string, content: string, executable: boolean, lock: Lock | null): Action {
  const current = readText(join(root, path));
  const entry = lock?.files[path];
  if (current === null) return { kind: "create", path, module: module.id, content, executable };
  if (current === content) return { kind: "unchanged", path, module: module.id, content, executable };
  if (entry && !entry.adopted && sha256(current) === entry.sha256) {
    return { kind: "update", path, module: module.id, content, executable };
  }
  const reason: ConflictReason = !entry ? "unmanaged" : entry.adopted ? "adopted" : "edited";
  return { kind: "conflict", path, module: module.id, content, reason };
}

function symlinkAction(root: string, module: LoadedModule, path: string, target: string): Action {
  const full = join(root, path);
  let existing: string | null = null;
  try {
    existing = lstatSync(full).isSymbolicLink() ? readlinkSync(full) : "(not a symlink)";
  } catch {
    return { kind: "symlink", path, target, module: module.id };
  }
  return existing === target
    ? { kind: "symlink", path, target, module: module.id }
    : { kind: "symlink-conflict", path, target, module: module.id };
}

export function plan(input: { root: string; detection: Detection; modules: Map<string, LoadedModule>; requested: string[] }): Plan {
  const lock = readLock(input.root);
  const requested = [...new Set([...(lock?.modules ?? []), ...input.requested])];
  const { ordered, addedFor } = resolveSelection(requested, input.modules);
  const vars = buildVars(input.detection, ordered);
  const pkg: PackageJson = readPackageJson(input.root) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const actions: Action[] = [];
  const devDependencies = new Set<string>();

  for (const id of ordered) {
    const module = input.modules.get(id);
    if (!module) continue;
    for (const file of module.files) {
      if (!conditionHolds(file.when, vars)) continue;
      const source = readFileSync(join(module.dir, "templates", file.path), "utf8");
      const content = renderTemplate(source, vars);
      actions.push(fileAction(input.root, module, file.path, content, file.executable === true, lock));
    }
    for (const link of module.symlinks) actions.push(symlinkAction(input.root, module, link.path, link.target));
    for (const [name, rawCommand] of Object.entries(module.packageScripts)) {
      const command = renderTemplate(rawCommand, vars);
      const existing = pkg.scripts?.[name];
      if (existing === undefined) actions.push({ kind: "script", name, command, module: id });
      else if (existing !== command) actions.push({ kind: "script-conflict", name, command, existing, module: id });
    }
    for (const [key, value] of Object.entries(module.packageFields)) {
      if (pkg[key] === undefined) actions.push({ kind: "field", key, value, module: id });
    }
    for (const entry of module.lines) {
      const path = renderTemplate(entry.path, vars);
      const present = new Set((readText(join(input.root, path)) ?? "").split("\n"));
      for (const line of entry.lines) if (!present.has(line)) actions.push({ kind: "line", path, line, module: id });
    }
    for (const dependency of module.devDependencies) if (!(dependency in deps)) devDependencies.add(dependency);
  }

  const missing = [...devDependencies];
  const addCommand = vars.pm === "bun" ? "bun add -d --exact" : "pnpm add -D --save-exact";
  return {
    modules: ordered,
    addedFor,
    actions,
    devDependencies: missing,
    installCommand: missing.length > 0 ? `${addCommand} ${missing.join(" ")}` : null,
  };
}

/** Unlike `existsSync`, true for a symlink whose target does not exist yet. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeFile(path: string, content: string, executable: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}

export function execute(root: string, result: Plan): Lock {
  const previous = readLock(root);
  const lock: Lock = { kitVersion: KIT_VERSION, modules: result.modules, files: { ...previous?.files } };
  const pkg = readPackageJson(root);
  let pkgChanged = false;
  const linesByFile = new Map<string, string[]>();

  for (const action of result.actions) {
    switch (action.kind) {
      case "create":
      case "update":
      case "unchanged": {
        if (action.kind !== "unchanged") writeFile(join(root, action.path), action.content, action.executable);
        const adopted = previous?.files[action.path]?.adopted;
        lock.files[action.path] = { module: action.module, sha256: sha256(action.content), ...(adopted ? { adopted } : {}) };
        break;
      }
      case "conflict":
        writeFile(join(root, action.path + NEW_SUFFIX), action.content, false);
        break;
      case "symlink": {
        const full = join(root, action.path);
        if (!pathExists(full)) {
          mkdirSync(dirname(full), { recursive: true });
          symlinkSync(action.target, full);
        }
        break;
      }
      case "script":
        if (pkg) {
          pkg.scripts = { ...pkg.scripts, [action.name]: action.command };
          pkgChanged = true;
        }
        break;
      case "field":
        if (pkg) {
          pkg[action.key] = action.value;
          pkgChanged = true;
        }
        break;
      case "line":
        linesByFile.set(action.path, [...(linesByFile.get(action.path) ?? []), action.line]);
        break;
      case "symlink-conflict":
      case "script-conflict":
        break;
    }
  }

  if (pkg && pkgChanged) writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [path, lines] of linesByFile) {
    const full = join(root, path);
    const current = readText(full) ?? "";
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFile(full, `${current}${separator}${lines.join("\n")}\n`, false);
  }
  writeLock(root, lock);
  return lock;
}

export type Drift = { path: string; state: "missing" | "edited" | "outdated" };

/** Reports managed files that are gone, edited by hand, or older than what this kit renders now. */
export function check(input: { root: string; detection: Detection; modules: Map<string, LoadedModule> }): Drift[] {
  const lock = readLock(input.root);
  if (!lock) throw new Error(`${LOCK_FILE} not found: repo-kit was never applied here`);
  const fresh = plan({ ...input, requested: lock.modules });
  const rendered = new Map<string, string>();
  for (const action of fresh.actions) if ("content" in action) rendered.set(action.path, action.content);

  const drift: Drift[] = [];
  for (const [path, entry] of Object.entries(lock.files)) {
    const current = readText(join(input.root, path));
    if (current === null) drift.push({ path, state: "missing" });
    else if (!entry.adopted && sha256(current) !== entry.sha256) drift.push({ path, state: "edited" });
    else if (!entry.adopted && rendered.has(path) && rendered.get(path) !== current) drift.push({ path, state: "outdated" });
  }
  return drift;
}

/** Marks files as owned by the project: later runs propose updates in `*.repo-kit-new` instead of writing. */
export function adopt(root: string, paths: string[], modules: Map<string, LoadedModule>): Lock {
  const lock = readLock(root);
  if (!lock) throw new Error(`${LOCK_FILE} not found: run apply first`);
  for (const path of paths) {
    const current = readText(join(root, path));
    if (current === null) throw new Error(`cannot adopt ${path}: file does not exist`);
    const owner =
      lock.files[path]?.module ??
      [...modules.values()].find((module) => lock.modules.includes(module.id) && module.files.some((file) => file.path === path))?.id;
    if (!owner) throw new Error(`cannot adopt ${path}: no selected module owns it`);
    lock.files[path] = { module: owner, sha256: sha256(current), adopted: true };
    rmSync(join(root, path + NEW_SUFFIX), { force: true });
  }
  writeLock(root, lock);
  return lock;
}

export function remove(root: string, moduleId: string, modules: Map<string, LoadedModule>): { deleted: string[]; kept: string[] } {
  const lock = readLock(root);
  if (!lock) throw new Error(`${LOCK_FILE} not found: run apply first`);
  const dependents = lock.modules.filter((id) => id !== moduleId && modules.get(id)?.requires.includes(moduleId));
  if (dependents.length > 0) throw new Error(`cannot remove ${moduleId}: required by ${dependents.join(", ")}`);
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const [path, entry] of Object.entries(lock.files)) {
    if (entry.module !== moduleId) continue;
    const current = readText(join(root, path));
    if (current !== null && !entry.adopted && sha256(current) === entry.sha256) {
      rmSync(join(root, path));
      deleted.push(path);
    } else if (current !== null) {
      kept.push(path);
    }
    delete lock.files[path];
  }
  lock.modules = lock.modules.filter((id) => id !== moduleId);
  writeLock(root, lock);
  return { deleted, kept };
}
