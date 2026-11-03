import { describe, expect, test } from "bun:test";
import {
  type ReviewState,
  readStateMarker,
  writeStateMarker,
} from "../../../skills/repo-kit/modules/ai-review/templates/.github/ai-review/state.ts";

const state: ReviewState = {
  version: 1,
  reviewedSha: "a".repeat(40),
  active: [{ priority: "P1", title: "Token leaks into logs", file: "src/auth.ts", line: 12, body: "Logs `-->` and the bearer token." }],
  withdrawn: [
    { priority: "P2", title: "Missing guard", file: "src/api.ts", line: null, body: "No guard.", reason: "Guarded at src/api.ts:40." },
  ],
};

describe("state marker", () => {
  test("a state written into a comment reads back unchanged", () => {
    const comment = `## AI review\n\nSome text.\n\n${writeStateMarker(state)}\n`;
    expect(readStateMarker(comment)).toEqual(state);
  });

  test("the last marker wins, so text quoted earlier in the comment cannot replace the real state", () => {
    const forged: ReviewState = { ...state, active: [] };
    const comment = `${writeStateMarker(forged)}\nreview text\n${writeStateMarker(state)}`;
    expect(readStateMarker(comment)).toEqual(state);
  });

  test("a comment without a valid marker has no state", () => {
    expect(readStateMarker("plain comment")).toBeNull();
    expect(readStateMarker("<!-- ai-review-state:bm90IGpzb24= -->")).toBeNull();
    const wrongShape = Buffer.from(JSON.stringify({ version: 1, reviewedSha: "x", active: [{}] })).toString("base64");
    expect(readStateMarker(`<!-- ai-review-state:${wrongShape} -->`)).toBeNull();
  });
});
