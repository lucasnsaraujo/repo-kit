import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ModuleFile = {
  /** Path under the module's `templates/` folder, which is also the path written in the project. */
  path: string;
  /** Template condition, same syntax as `{%if ...%}`: write the file only when it holds. */
  when?: string;
  executable?: boolean;
};

export type ModuleManifest = {
  id: string;
  summary: string;
  requires: string[];
  files: ModuleFile[];
  symlinks: { path: string; target: string }[];
  packageScripts: Record<string, string>;
  packageFields: Record<string, unknown>;
  lines: { path: string; lines: string[] }[];
  devDependencies: string[];
};

export type LoadedModule = ModuleManifest & { dir: string };

function readManifest(dir: string): LoadedModule {
  const raw: Partial<ModuleManifest> = JSON.parse(readFileSync(join(dir, "module.json"), "utf8"));
  if (!raw.id || !raw.summary) throw new Error(`${dir}/module.json needs id and summary`);
  return {
    dir,
    id: raw.id,
    summary: raw.summary,
    requires: raw.requires ?? [],
    files: raw.files ?? [],
    symlinks: raw.symlinks ?? [],
    packageScripts: raw.packageScripts ?? {},
    packageFields: raw.packageFields ?? {},
    lines: raw.lines ?? [],
    devDependencies: raw.devDependencies ?? [],
  };
}

export function loadModules(modulesDir: string): Map<string, LoadedModule> {
  const modules = new Map<string, LoadedModule>();
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    const dir = join(modulesDir, entry.name);
    if (!entry.isDirectory() || !existsSync(join(dir, "module.json"))) continue;
    const manifest = readManifest(dir);
    if (manifest.id !== entry.name) throw new Error(`${dir}: id "${manifest.id}" must match its folder name`);
    modules.set(manifest.id, manifest);
  }
  return modules;
}

/** Expands the selection with every module it requires, in dependency order. */
export function resolveSelection(
  requested: string[],
  modules: Map<string, LoadedModule>,
): { ordered: string[]; addedFor: Record<string, string> } {
  const ordered: string[] = [];
  const addedFor: Record<string, string> = {};
  const visiting = new Set<string>();

  const visit = (id: string, requiredBy: string | null) => {
    if (ordered.includes(id)) return;
    const module = modules.get(id);
    if (!module) throw new Error(`unknown module: ${id}${requiredBy ? ` (required by ${requiredBy})` : ""}`);
    if (visiting.has(id)) throw new Error(`module dependency cycle at ${id}`);
    visiting.add(id);
    for (const dependency of module.requires) visit(dependency, id);
    visiting.delete(id);
    if (requiredBy && !requested.includes(id)) addedFor[id] = requiredBy;
    ordered.push(id);
  };

  for (const id of requested) visit(id, null);
  return { ordered, addedFor };
}
