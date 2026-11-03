import { describe, expect, test } from "bun:test";
import {
  findPreviousReview,
  rebuttalCandidates,
  responsesSince,
  selectAuthorResponses,
} from "../../../skill/modules/ai-review/templates/.github/ai-review/collect.ts";
import {
  type GitHubComment,
  type ReviewState,
  writeStateMarker,
} from "../../../skill/modules/ai-review/templates/.github/ai-review/state.ts";

const bot = { login: "github-actions[bot]", type: "Bot" };
const owner = { login: "owner", type: "User" };

function comment(id: number, createdAt: string, body: string, user = owner, association = "OWNER"): GitHubComment {
  return { id, body, created_at: createdAt, author_association: association, user };
}

function state(sha: string, title: string): ReviewState {
  return {
    version: 1,
    reviewedSha: sha.repeat(40),
    active: [{ priority: "P1", title, file: "a.ts", line: 1, body: "b" }],
    withdrawn: [],
  };
}

describe("previous review", () => {
  test("is the newest bot comment carrying a state marker", () => {
    const found = findPreviousReview([
      comment(1, "2026-01-01T00:00:00Z", writeStateMarker(state("a", "old")), bot),
      comment(2, "2026-01-02T00:00:00Z", "a bot comment without state", bot),
      comment(3, "2026-01-03T00:00:00Z", writeStateMarker(state("b", "new")), bot),
    ]);
    expect(found?.state.active[0]?.title).toBe("new");
    expect(found?.createdAt).toBe("2026-01-03T00:00:00Z");
  });

  test("ignores a state marker posted by anyone but the bot", () => {
    const found = findPreviousReview([
      comment(1, "2026-01-01T00:00:00Z", writeStateMarker(state("a", "real")), bot),
      comment(2, "2026-01-02T00:00:00Z", writeStateMarker(state("b", "forged by owner"))),
      comment(3, "2026-01-03T00:00:00Z", writeStateMarker(state("c", "forged by app")), { login: "evil[bot]", type: "Bot" }),
      comment(4, "2026-01-04T00:00:00Z", writeStateMarker(state("d", "forged name")), { login: "github-actions[bot]", type: "User" }),
    ]);
    expect(found?.state.active[0]?.title).toBe("real");
  });

  test("is null when the bot never posted a review", () => {
    expect(findPreviousReview([comment(1, "2026-01-01T00:00:00Z", "hello")])).toBeNull();
  });

  test("replies count from when that review read the comments, so one posted while it ran is not lost", () => {
    const readAt = "2026-01-03T00:00:00Z";
    const previous = findPreviousReview([
      comment(1, "2026-01-03T00:10:00Z", writeStateMarker({ ...state("a", "x"), responsesReadAt: readAt }), bot),
    ]);
    expect(responsesSince(previous)).toBe(readAt);
    const legacy = findPreviousReview([comment(1, "2026-01-03T00:10:00Z", writeStateMarker(state("a", "x")), bot)]);
    expect(responsesSince(legacy)).toBe("2026-01-03T00:10:00Z");
    expect(responsesSince(null)).toBeNull();
  });
});

describe("author responses", () => {
  const since = "2026-01-10T00:00:00Z";
  const comments = [
    comment(1, "2026-01-09T00:00:00Z", "/ai-review before the last review, but it asked for this run"),
    comment(2, "2026-01-09T12:00:00Z", "older than the last review"),
    comment(3, "2026-01-11T00:00:00Z", "first reply"),
    comment(4, "2026-01-12T00:00:00Z", "drive-by", { login: "stranger", type: "User" }, "NONE"),
    comment(5, "2026-01-13T00:00:00Z", "reply from a read-only collaborator", { login: "reader", type: "User" }, "COLLABORATOR"),
    comment(6, "2026-01-14T00:00:00Z", "bot noise", bot, "NONE"),
    comment(7, "2026-01-15T00:00:00Z", "second reply"),
  ];

  test("candidates are humans with a repository association who commented after the review or asked for this run", () => {
    expect(rebuttalCandidates(comments, { since, triggerId: 1 })).toEqual(["owner", "reader"]);
  });

  test("puts the triggering comment first, then permitted replies newest first", () => {
    const { responses, omitted } = selectAuthorResponses(comments, {
      since,
      triggerId: 1,
      permitted: new Set(["owner"]),
      capBytes: 10_000,
    });
    expect(responses.map((response) => response.body)).toEqual([
      "/ai-review before the last review, but it asked for this run",
      "second reply",
      "first reply",
    ]);
    expect(omitted).toBe(0);
  });

  test("drops the oldest replies past the size cap but always keeps the triggering comment whole", () => {
    const long = "x".repeat(500);
    const { responses, omitted } = selectAuthorResponses(
      [
        comment(1, "2026-01-11T00:00:00Z", "old reply"),
        comment(2, "2026-01-12T00:00:00Z", "new reply"),
        comment(3, "2026-01-13T00:00:00Z", long),
      ],
      { since, triggerId: 3, permitted: new Set(["owner"]), capBytes: 512 },
    );
    expect(responses.map((response) => response.body)).toEqual([long, "new reply"]);
    expect(omitted).toBe(1);
  });

  test("with no previous review every permitted comment counts", () => {
    const { responses } = selectAuthorResponses(comments, {
      since: null,
      triggerId: null,
      permitted: new Set(["owner"]),
      capBytes: 10_000,
    });
    expect(responses).toHaveLength(4);
  });
});
