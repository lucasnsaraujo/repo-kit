import { describe, expect, test } from "bun:test";
import { type LoadedModule, resolveSelection, selectAll } from "../skills/repo-kit/scripts/lib/modules.ts";

function catalogue(entries: { id: string; requires?: string[]; conflicts?: string[] }[]): Map<string, LoadedModule> {
  return new Map(
    entries.map(({ id, requires = [], conflicts = [] }) => [
      id,
      {
        dir: `/modules/${id}`,
        id,
        summary: id,
        requires,
        conflicts,
        files: [],
        symlinks: [],
        packageScripts: {},
        packageFields: {},
        lines: [],
        devDependencies: [],
      },
    ]),
  );
}

const reviewers = catalogue([
  { id: "docs" },
  { id: "review" },
  { id: "loops", requires: ["docs", "review"] },
  { id: "server-review", conflicts: ["review"] },
]);

describe("conflicting modules", () => {
  test("selecting both alternatives on a fresh project fails without a remove hint", () => {
    const attempt = () => resolveSelection(["review", "server-review"], reviewers);
    expect(attempt).toThrow(/server-review and review cannot be selected together.*Pick one/);
    expect(attempt).not.toThrow(/remove/);
  });

  test("on a configured project the hint removes the recorded alternative, whichever side declares the conflict", () => {
    expect(() => resolveSelection(["server-review", "review"], reviewers, ["server-review"])).toThrow(
      /run `kit.ts remove server-review` first/,
    );
    expect(() => resolveSelection(["review", "server-review"], reviewers, ["review"])).toThrow(/run `kit.ts remove review` first/);
  });

  test("a module that pulls in the other alternative is named", () => {
    expect(() => resolveSelection(["server-review", "loops"], reviewers, ["server-review"])).toThrow(
      /loops requires review.*run `kit.ts remove server-review` first/,
    );
  });

  test("one alternative alone resolves", () => {
    expect(resolveSelection(["server-review", "docs"], reviewers).ordered).toEqual(["server-review", "docs"]);
  });
});

describe("selectAll", () => {
  test("leaves out opt-in alternatives on a fresh project", () => {
    expect(selectAll(reviewers, [])).toEqual(["docs", "review", "loops"]);
  });

  test("keeps the recorded alternative and drops every module that would pull in its conflict", () => {
    const all = selectAll(reviewers, ["server-review"]);
    expect(all).toEqual(["docs", "server-review"]);
    expect(() => resolveSelection(all, reviewers)).not.toThrow();
  });
});
