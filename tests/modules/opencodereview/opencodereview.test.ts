import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadModules, resolveSelection } from "../../../skills/repo-kit/scripts/lib/modules.ts";
import { applyModules, REPO_ROOT, removeTempDirs } from "../../helpers/render-module.ts";

afterAll(removeTempDirs);

const kit = loadModules(join(REPO_ROOT, "skills/repo-kit/modules"));

describe("opencodereview module", () => {
  test("writes REVIEW.md pointing at AGENTS.md only when agent-docs is selected", () => {
    const withDocs = applyModules({ lockfile: "bun.lock", modules: ["opencodereview", "agent-docs"] });
    const alone = applyModules({ lockfile: "bun.lock", modules: ["opencodereview"] });

    expect(readFileSync(join(withDocs, "REVIEW.md"), "utf8")).toContain("[AGENTS.md](AGENTS.md)");
    expect(readFileSync(join(alone, "REVIEW.md"), "utf8")).not.toContain("AGENTS.md");
  });

  test("cannot be selected with ai-review, directly or through agent-loops", () => {
    expect(() => resolveSelection(["opencodereview", "ai-review"], kit)).toThrow(/cannot be selected together/);
    expect(() => resolveSelection(["opencodereview", "agent-loops"], kit)).toThrow(/cannot be selected together/);
  });
});
