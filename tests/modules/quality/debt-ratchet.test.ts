import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Counts, type Ratchet, runRatchet } from "../../../skill/modules/quality/templates/scripts/debt-ratchet.ts";
import { removeTempDirs, tempDir } from "../../helpers/render-module.ts";

afterEach(removeTempDirs);

function setup(initial: Counts | null) {
  const baselinePath = join(tempDir(), "tools/ratchet/baseline.json");
  let current: Counts = {};
  const log: string[] = [];
  const ratchet: Ratchet = {
    script: "ratchet",
    baselinePath,
    noun: "errors",
    suggestedChecks: ["strict"],
    finishedStep: (check) => `turn ${check} on`,
    count: (checks) => Object.fromEntries(checks.map((check) => [check, current[check] ?? {}])),
  };
  const writeBaseline = (counts: unknown) => {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(counts));
  };
  if (initial) writeBaseline(initial);
  return {
    run: (counts: Counts, ...args: string[]) => {
      current = counts;
      log.length = 0;
      return runRatchet(ratchet, args, (line) => log.push(line));
    },
    baseline: (): Counts => JSON.parse(readFileSync(baselinePath, "utf8")),
    writeBaseline,
    baselinePath,
    log,
  };
}

describe("without a baseline", () => {
  test("fails and prints the command that starts one", () => {
    const ratchet = setup(null);
    expect(ratchet.run({})).toBe(1);
    expect(ratchet.log.join("\n")).toContain("ratchet --add=strict");
    expect(existsSync(ratchet.baselinePath)).toBe(false);
  });

  test("--add records the check's current counts, creating the baseline's folder", () => {
    const ratchet = setup(null);
    expect(ratchet.run({ strict: { "a.ts": 2 } }, "--add=strict")).toBe(0);
    expect(ratchet.baseline()).toEqual({ strict: { "a.ts": 2 } });
  });
});

describe("with a baseline", () => {
  test("passes while every count matches", () => {
    const ratchet = setup({ strict: { "a.ts": 2 } });
    expect(ratchet.run({ strict: { "a.ts": 2 } })).toBe(0);
  });

  test("fails when a file rises above its count or a file outside the baseline gains a finding", () => {
    const ratchet = setup({ strict: { "a.ts": 2 } });
    expect(ratchet.run({ strict: { "a.ts": 3 } })).toBe(1);
    expect(ratchet.log).toContain("a.ts: 3 errors under strict, baseline allows 2. Fix the new ones.");
    expect(ratchet.run({ strict: { "a.ts": 2, "c.ts": 1 } })).toBe(1);
    expect(ratchet.log).toContain("c.ts: 1 errors under strict, baseline allows 0. Fix the new ones.");
  });

  test("fails when a count drops, until --write lowers it", () => {
    const ratchet = setup({ strict: { "a.ts": 3, "b.ts": 1 } });
    expect(ratchet.run({ strict: { "a.ts": 1, "b.ts": 1 } })).toBe(1);
    expect(ratchet.log.join("\n")).toContain("ratchet --write");
    expect(ratchet.run({ strict: { "a.ts": 1, "b.ts": 1 } }, "--write")).toBe(0);
    expect(ratchet.baseline()).toEqual({ strict: { "a.ts": 1, "b.ts": 1 } });
    expect(ratchet.run({ strict: { "a.ts": 1, "b.ts": 1 } })).toBe(0);
  });

  test("--write lowers what dropped, drops fixed files, and never raises what rose", () => {
    const ratchet = setup({ strict: { "a.ts": 2, "b.ts": 3, "c.ts": 1 } });
    expect(ratchet.run({ strict: { "a.ts": 5, "b.ts": 1, "d.ts": 4 } }, "--write")).toBe(1);
    expect(ratchet.baseline()).toEqual({ strict: { "a.ts": 2, "b.ts": 1 } });
  });

  test("a check with nothing left keeps failing with its finishing step, even after --write", () => {
    const ratchet = setup({ strict: { "a.ts": 1 } });
    expect(ratchet.run({}, "--write")).toBe(0);
    expect(ratchet.baseline()).toEqual({ strict: {} });
    expect(ratchet.run({})).toBe(1);
    expect(ratchet.log).toContain("strict: no errors left. turn strict on");
  });

  test("refuses to start a check it already holds", () => {
    const ratchet = setup({ strict: {} });
    expect(() => ratchet.run({}, "--add=strict")).toThrow("already in the baseline");
  });

  test("rejects a baseline whose counts are not whole numbers", () => {
    const ratchet = setup(null);
    ratchet.writeBaseline({ strict: { "a.ts": "2" } });
    expect(() => ratchet.run({})).toThrow("must be a whole number");
  });
});
