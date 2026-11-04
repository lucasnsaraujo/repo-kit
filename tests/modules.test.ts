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
  test("selecting both alternatives fails and names the remove command", () => {
    expect(() => resolveSelection(["review", "server-review"], reviewers)).toThrow(
      /server-review and review cannot be selected together.*remove review/,
    );
  });

  test("a module that pulls in the other alternative fails too", () => {
    expect(() => resolveSelection(["server-review", "loops"], reviewers)).toThrow(/loops requires review; leave loops out/);
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
