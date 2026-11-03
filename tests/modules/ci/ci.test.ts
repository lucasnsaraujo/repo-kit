import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildVars } from "../../../skill/scripts/lib/apply.ts";
import { detect } from "../../../skill/scripts/lib/detect.ts";
import { renderTemplate } from "../../../skill/scripts/lib/render.ts";
import { applyModules, type Lockfile, REPO_ROOT, removeTempDirs, tempDir, writeFiles } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

type Step = { id?: string; run?: string };
type Workflow = { jobs: Record<string, { if?: string; steps: Step[] }> };

function actionlint(project: string): { status: number | null; output: string } {
  execFileSync("git", ["init", "-q"], { cwd: project });
  const result = spawnSync("actionlint", ["-no-color"], { cwd: project, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Renders ci.yml with every optional module turned on, so the docs and secrets jobs exist. */
function renderFullWorkflow(lockfile: Lockfile): string {
  const project = applyModules({ lockfile, modules: ["ci"] });
  const vars = buildVars(detect(project), ["ci", "quality", "tests", "agent-docs", "supply-chain"]);
  const source = readFileSync(join(REPO_ROOT, "skill/modules/ci/templates/.github/workflows/ci.yml"), "utf8");
  writeFileSync(join(project, ".github/workflows/ci.yml"), renderTemplate(source, vars));
  return project;
}

function readWorkflow(project: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(project, ".github/workflows/ci.yml"), "utf8")) as Workflow;
}

function workflowStep(project: string, job: string, match: (step: Step) => boolean): string {
  const workflow = readWorkflow(project);
  const run = workflow.jobs[job]?.steps.find(match)?.run;
  if (run === undefined) throw new Error(`no matching step in ${job}`);
  return run;
}

describe("rendered workflows", () => {
  for (const lockfile of ["bun.lock", "pnpm-lock.yaml"] as const) {
    test(`pass actionlint for ${lockfile} with only the ci module`, () => {
      const project = applyModules({ lockfile, modules: ["ci"] });
      expect(actionlint(project)).toEqual({ status: 0, output: "" });
    });

    test(`pass actionlint for ${lockfile} with every optional job rendered`, () => {
      expect(actionlint(renderFullWorkflow(lockfile))).toEqual({ status: 0, output: "" });
    });
  }

  test("the docs and secret scan jobs run on every change, whatever the lanes say", () => {
    const jobs = readWorkflow(renderFullWorkflow("bun.lock")).jobs;
    expect(jobs.docs?.if).toBeUndefined();
    expect(jobs.secrets?.if).toBeUndefined();
  });

  test("the setup action installs with the project's package manager", () => {
    const bun = readFileSync(join(applyModules({ lockfile: "bun.lock", modules: ["ci"] }), ".github/actions/setup/action.yml"), "utf8");
    const pnpm = readFileSync(
      join(applyModules({ lockfile: "pnpm-lock.yaml", modules: ["ci"] }), ".github/actions/setup/action.yml"),
      "utf8",
    );
    expect(bun).toContain("run: bun install --frozen-lockfile");
    expect(bun).not.toContain("pnpm/action-setup");
    expect(pnpm).toContain("run: pnpm install --frozen-lockfile");
    expect(pnpm).not.toContain("oven-sh/setup-bun");
  });
});

describe("All checks pass", () => {
  const project = renderFullWorkflow("bun.lock");
  const script = workflowStep(project, "ci-ok", (step) => step.run?.includes("jq -e") === true);

  const gate = (needs: Record<string, { result: string; outputs?: Record<string, string> }>) =>
    spawnSync("bash", ["-e", "-c", script], { env: { ...process.env, NEEDS: JSON.stringify(needs) }, encoding: "utf8" }).status;

  const lanes = (check: string, test: string) => ({ result: "success", outputs: { check, test } });

  test("passes when every job succeeded", () => {
    expect(gate({ changes: lanes("true", "true"), check: { result: "success" }, test: { result: "success" } })).toBe(0);
  });

  test("passes when a job skipped because its lane was not needed", () => {
    expect(gate({ changes: lanes("false", "false"), check: { result: "skipped" }, docs: { result: "success" } })).toBe(0);
  });

  test("fails when a job skipped although its lane was needed", () => {
    expect(gate({ changes: lanes("true", "true"), check: { result: "skipped" }, test: { result: "success" } })).toBe(1);
  });

  test("fails when a job failed or was cancelled", () => {
    expect(gate({ changes: lanes("true", "true"), check: { result: "failure" }, test: { result: "success" } })).toBe(1);
    expect(gate({ changes: lanes("true", "true"), check: { result: "success" }, test: { result: "cancelled" } })).toBe(1);
  });

  test("fails when a job without a lane, such as docs, was skipped", () => {
    expect(gate({ changes: lanes("false", "false"), check: { result: "skipped" }, docs: { result: "skipped" } })).toBe(1);
  });

  test("fails when the changes job itself failed and everything skipped", () => {
    expect(gate({ changes: { result: "failure", outputs: {} }, check: { result: "skipped" }, secrets: { result: "skipped" } })).toBe(1);
  });
});

describe("lane picking", () => {
  const project = renderFullWorkflow("bun.lock");
  const script = workflowStep(project, "changes", (step) => step.id === "lanes");

  /** Commits `changed` on top of a base commit and runs the lane script as a pull request would. */
  function pickLanes(changed: Record<string, string>, event = "pull_request"): Record<string, string> {
    const repo = tempDir("repo-kit-lanes-");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    writeFiles(repo, { "README.md": "base\n", "src/app.ts": "export {};\n" });
    git("add", ".");
    git("commit", "-qm", "base");
    writeFiles(repo, changed);
    git("add", ".");
    git("commit", "-qm", "change");
    const output = join(repo, ".github-output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: repo,
      env: { ...process.env, EVENT_NAME: event, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  }

  test("a markdown-only change skips the code lanes", () => {
    expect(pickLanes({ "README.md": "edited\n", "docs/guide.mdx": "x\n" })).toEqual({ check: "false", test: "false" });
  });

  test("a source change runs the code lanes", () => {
    expect(pickLanes({ "src/app.ts": "export const a = 1;\n" })).toEqual({ check: "true", test: "true" });
  });

  test("a lockfile, manifest or workflow change runs every lane", () => {
    const all = { check: "true", test: "true" };
    expect(pickLanes({ "bun.lock": "changed\n" })).toEqual(all);
    expect(pickLanes({ "package.json": "{}\n" })).toEqual(all);
    expect(pickLanes({ ".github/workflows/other.yml": "x: 1\n" })).toEqual(all);
  });

  test("a path no lane claims runs every lane", () => {
    expect(pickLanes({ Dockerfile: "FROM scratch\n", "README.md": "edited\n" })).toEqual({ check: "true", test: "true" });
  });

  test("a push runs every lane whatever changed", () => {
    expect(pickLanes({ "README.md": "edited\n" }, "push")).toEqual({ check: "true", test: "true" });
  });
});
