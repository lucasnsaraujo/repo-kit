import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countErrorsByFile, pendingOptions } from "../../../skills/repo-kit/modules/quality/templates/scripts/type-ratchet.mts";
import { applyModules, removeTempDirs, writeFiles } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

describe("countErrorsByFile", () => {
  test("counts errors per file, skips continuation lines, and counts a repeated line once", () => {
    const output = [
      "src/a.ts(2,14): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
      "  Type 'undefined' is not assignable to type 'string'.",
      "src/a.ts(9,1): error TS4114: This member must have an 'override' modifier.",
      "src/a.ts(9,1): error TS4114: This member must have an 'override' modifier.",
      "src\\win\\b.ts(1,1): error TS2532: Object is possibly 'undefined'.",
      "Found 3 errors.",
    ].join("\n");
    expect(countErrorsByFile(output)).toEqual({ "src/a.ts": 2, "src/win/b.ts": 1 });
  });
});

describe("pendingOptions", () => {
  test("lists the strict options the resolved config leaves off", () => {
    const showConfig = JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: false } });
    expect(pendingOptions(showConfig)).toEqual([
      "exactOptionalPropertyTypes",
      "noPropertyAccessFromIndexSignature",
      "noImplicitOverride",
      "noImplicitReturns",
      "noFallthroughCasesInSwitch",
    ]);
  });
});

describe("type-ratchet script", () => {
  test("records an option's errors per file, then fails when a file gains one", () => {
    const project = applyModules({ lockfile: "bun.lock", modules: ["quality"], linkNodeModules: true });
    writeFiles(project, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "nodenext" },
        include: ["src"],
      }),
      "src/list.ts": "const items: string[] = [];\nexport const first: string = items[0];\n",
    });
    const ratchet = (...args: string[]) => spawnSync("node", ["scripts/type-ratchet.mts", ...args], { cwd: project, encoding: "utf8" });

    const started = ratchet("--add=noUncheckedIndexedAccess");
    expect(started.status).toBe(0);
    expect(JSON.parse(readFileSync(join(project, "tools/ratchet/types.json"), "utf8"))).toEqual({
      noUncheckedIndexedAccess: { "src/list.ts": 1 },
    });
    expect(ratchet().status).toBe(0);

    writeFiles(project, {
      "src/list.ts": "const items: string[] = [];\nexport const first: string = items[0];\nexport const second: string = items[1];\n",
    });
    const regressed = ratchet();
    expect(regressed.status).toBe(1);
    expect(regressed.stdout).toContain("src/list.ts: 2 type errors under noUncheckedIndexedAccess, baseline allows 1");
  });

  test("passes without a baseline when the tsconfig already turns every strict option on", () => {
    const project = applyModules({ lockfile: "bun.lock", modules: ["quality"], linkNodeModules: true });
    const strictOptions = {
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noPropertyAccessFromIndexSignature: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
    };
    writeFiles(project, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { ...strictOptions, noEmit: true }, include: ["src"] }),
      "src/a.ts": "export {};\n",
    });
    const result = spawnSync("node", ["scripts/type-ratchet.mts"], { cwd: project, encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  test("refuses to add an option the tsconfig already turns on", () => {
    const project = applyModules({ lockfile: "bun.lock", modules: ["quality"], linkNodeModules: true });
    writeFiles(project, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noImplicitOverride: true, noEmit: true }, include: ["src"] }),
      "src/a.ts": "export {};\n",
    });
    const result = spawnSync("node", ["scripts/type-ratchet.mts", "--add=noImplicitOverride"], { cwd: project, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("noImplicitOverride is not a strict option");
  });
});
