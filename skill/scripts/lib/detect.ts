import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

export type PackageJson = {
  name?: string;
  private?: boolean;
  workspaces?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
  main?: string;
  engines?: { node?: string };
  packageManager?: string;
  [key: string]: unknown;
};

export type Detection = {
  root: string;
  packageManager: PackageManager | null;
  monorepo: boolean;
  defaultBranch: string;
  nodeVersion: string;
  githubRemote: boolean;
  isLibrary: boolean;
  scripts: Record<string, string>;
  tools: Record<ToolName, boolean>;
  workflows: string[];
};

type ToolName =
  | "typescript"
  | "biome"
  | "eslint"
  | "prettier"
  | "oxlint"
  | "husky"
  | "lefthook"
  | "githooks"
  | "vitest"
  | "jest"
  | "playwright"
  | "knip"
  | "dotenvx"
  | "changesets"
  | "dependabot"
  | "renovate"
  | "agentsMd"
  | "claudeMd";

export function readPackageJson(root: string): PackageJson | null {
  const path = join(root, "package.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function detectPackageManager(root: string, pkg: PackageJson | null): PackageManager | null {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  const declared = pkg?.packageManager?.split("@")[0];
  return declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm" ? declared : null;
}

function detectDefaultBranch(root: string): string {
  const remoteHead = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead.replace(/^origin\//, "");
  return git(root, ["config", "init.defaultBranch"]) ?? "main";
}

function detectNodeVersion(root: string, pkg: PackageJson | null): string {
  for (const file of [".nvmrc", ".node-version"]) {
    const path = join(root, file);
    if (existsSync(path)) return readFileSync(path, "utf8").trim().replace(/^v/, "");
  }
  const engine = pkg?.engines?.node?.match(/\d+/)?.[0];
  return engine ?? "24";
}

export function detect(root: string): Detection {
  const pkg = readPackageJson(root);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const has = (name: string) => name in deps;
  const exists = (...paths: string[]) => paths.some((path) => existsSync(join(root, path)));
  const rootFiles = existsSync(root) ? readdirSync(root) : [];
  const startsWith = (prefix: string) => rootFiles.some((file) => file.startsWith(prefix));
  const workflowsDir = join(root, ".github/workflows");

  return {
    root,
    packageManager: detectPackageManager(root, pkg),
    monorepo: Boolean(pkg?.workspaces) || exists("pnpm-workspace.yaml"),
    defaultBranch: detectDefaultBranch(root),
    nodeVersion: detectNodeVersion(root, pkg),
    githubRemote: (git(root, ["remote", "get-url", "origin"]) ?? "").includes("github.com"),
    isLibrary: pkg?.private !== true && (pkg?.exports !== undefined || pkg?.main !== undefined),
    scripts: pkg?.scripts ?? {},
    tools: {
      typescript: has("typescript") || exists("tsconfig.json"),
      biome: has("@biomejs/biome") || exists("biome.json", "biome.jsonc"),
      eslint: has("eslint") || startsWith("eslint.config") || startsWith(".eslintrc"),
      prettier: has("prettier") || startsWith(".prettierrc") || startsWith("prettier.config"),
      oxlint: has("oxlint") || exists(".oxlintrc.json"),
      husky: has("husky") || exists(".husky"),
      lefthook: has("lefthook") || startsWith("lefthook."),
      githooks: exists(".githooks"),
      vitest: has("vitest") || startsWith("vitest.config"),
      jest: has("jest") || startsWith("jest.config"),
      playwright: has("@playwright/test") || startsWith("playwright.config"),
      knip: has("knip") || startsWith("knip.") || startsWith(".knip"),
      dotenvx: has("@dotenvx/dotenvx"),
      changesets: exists(".changeset"),
      dependabot: exists(".github/dependabot.yml", ".github/dependabot.yaml"),
      renovate: exists("renovate.json", ".github/renovate.json", "renovate.json5", ".renovaterc"),
      agentsMd: exists("AGENTS.md"),
      claudeMd: exists("CLAUDE.md"),
    },
    workflows: existsSync(workflowsDir) ? readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file)) : [],
  };
}
