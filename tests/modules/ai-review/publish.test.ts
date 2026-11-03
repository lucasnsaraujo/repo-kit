import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubClient } from "../../../skills/repo-kit/modules/ai-review/templates/.github/ai-review/github.ts";
import {
  decideStatus,
  mergeState,
  publishReview,
  readReviewResult,
  renderFailureComment,
  renderReviewComment,
} from "../../../skills/repo-kit/modules/ai-review/templates/.github/ai-review/publish.ts";
import {
  type Finding,
  type ReviewMeta,
  type ReviewState,
  readStateMarker,
  type StoredFinding,
} from "../../../skills/repo-kit/modules/ai-review/templates/.github/ai-review/state.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const headSha = "c".repeat(40);
const stored = (title: string, priority: StoredFinding["priority"] = "P1"): StoredFinding => ({
  priority,
  title,
  file: "src/a.ts",
  line: 3,
  body: `${title} body`,
});
const finding = (status: Finding["status"], title: string, priority: StoredFinding["priority"] = "P1", reason?: string): Finding => ({
  status,
  ...stored(title, priority),
  ...(reason ? { reason } : {}),
});

const previous: ReviewState = {
  version: 1,
  reviewedSha: "a".repeat(40),
  active: [stored("Fixed bug"), stored("Wrong claim"), stored("Still broken"), stored("Forgotten by the reviewer")],
  withdrawn: [{ ...stored("Settled long ago", "P2"), reason: "Guarded at src/a.ts:9." }],
};

const meta = (overrides: Partial<ReviewMeta> = {}): ReviewMeta => ({
  baseSha: "b".repeat(40),
  headSha,
  scope: { kind: "since", reviewedSha: previous.reviewedSha },
  previous,
  responsesReadAt: "2026-11-03T10:00:00Z",
  responseCount: 1,
  ...overrides,
});

const cliResult = (structured: unknown) => ({ type: "result", subtype: "success", is_error: false, structured_output: structured });

describe("reading the reviewer result", () => {
  test("accepts well-formed structured output", () => {
    const result = readReviewResult(cliResult({ verdict: "One P1.", findings: [finding("NEW", "Bug")] }));
    expect(result).toEqual({ ok: true, output: { verdict: "One P1.", findings: [finding("NEW", "Bug")] } });
  });

  test.each([
    ["missing verdict", cliResult({ findings: [] })],
    ["unknown priority", cliResult({ verdict: "v", findings: [{ ...finding("NEW", "Bug"), priority: "P9" }] })],
    ["resolved without a reason", cliResult({ verdict: "v", findings: [finding("RESOLVED", "Bug")] })],
    ["fractional line", cliResult({ verdict: "v", findings: [{ ...finding("NEW", "Bug"), line: 1.5 }] })],
    ["nothing written, as when Claude Code dies first", null],
    ["no structured output", { type: "result", subtype: "success", is_error: false, result: "## Verdict\nfine" }],
  ])("rejects %s as a failed review", (_, raw) => {
    const result = readReviewResult(raw);
    expect(result.ok).toBe(false);
  });

  test("reports the CLI's own error when the run failed", () => {
    const result = readReviewResult({ type: "result", subtype: "error_max_turns", is_error: true, result: "Credit balance is too low" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("Credit balance is too low") });
  });
});

describe("merging state", () => {
  const output = {
    verdict: "v",
    findings: [
      finding("RESOLVED", "Fixed bug", "P1", "Guard added."),
      finding("WITHDRAWN", "Wrong claim", "P1", "Checked at src/a.ts:5."),
      finding("REMAINS", "Still broken"),
      finding("NEW", "Fresh issue", "P0"),
    ],
  };

  test("keeps NEW and REMAINS active, adds withdrawals to the ledger, and records the head commit", () => {
    const { state, resolved } = mergeState({ meta: meta(), output });
    expect(state.reviewedSha).toBe(headSha);
    expect(state.responsesReadAt).toBe("2026-11-03T10:00:00Z");
    expect(state.active.map((item) => item.title)).toEqual(["Still broken", "Fresh issue", "Forgotten by the reviewer"]);
    expect(state.withdrawn.map((item) => item.title)).toEqual(["Settled long ago", "Wrong claim"]);
    expect(resolved.map((item) => item.title)).toEqual(["Fixed bug"]);
  });

  test("carries forward a previous finding the reviewer did not classify, so it cannot drop out of the gate", () => {
    const { open } = mergeState({ meta: meta(), output });
    const carried = open.find((entry) => entry.finding.title === "Forgotten by the reviewer");
    expect(carried?.status).toBe("REMAINS");
    expect(carried?.note).toContain("did not recheck");
  });

  test("a withdrawal counts only when an author response reached the run", () => {
    const { state, open } = mergeState({ meta: meta({ responseCount: 0 }), output });
    expect(state.withdrawn.map((item) => item.title)).toEqual(["Settled long ago"]);
    expect(state.active.map((item) => item.title)).toContain("Wrong claim");
    expect(open.find((entry) => entry.finding.title === "Wrong claim")?.status).toBe("REMAINS");
  });

  test("RESOLVED or WITHDRAWN for a finding the last review did not raise is ignored", () => {
    const invented = {
      verdict: "v",
      findings: [finding("RESOLVED", "Never raised", "P1", "Gone."), finding("WITHDRAWN", "Also never raised", "P1", "Wrong.")],
    };
    const { state, resolved } = mergeState({ meta: meta(), output: invented });
    expect(resolved).toEqual([]);
    expect(state.withdrawn.map((item) => item.title)).toEqual(["Settled long ago"]);
  });

  test("a withdrawal repeated by the reviewer is not listed twice", () => {
    const repeated = { verdict: "v", findings: [finding("WITHDRAWN", "Settled long ago", "P2", "Same reason.")] };
    const { state } = mergeState({
      meta: meta({ previous: { ...previous, active: [stored("Settled long ago", "P2")] } }),
      output: repeated,
    });
    expect(state.withdrawn.map((item) => item.title)).toEqual(["Settled long ago"]);
  });
});

describe("commit status", () => {
  const reviewed = (active: StoredFinding[]) => ({ kind: "reviewed" as const, active });

  test("advisory mode never blocks, and counts the findings in the description", () => {
    const decision = decideStatus({ gate: false, outcome: reviewed([stored("a", "P0"), stored("b", "P3")]) });
    expect(decision.state).toBe("success");
    expect(decision.description).toContain("2 open findings");
    expect(decision.description).toContain("1 P0/P1");
  });

  test("gate mode blocks only on active P0 or P1 findings", () => {
    expect(decideStatus({ gate: true, outcome: reviewed([stored("a", "P1")]) }).state).toBe("failure");
    expect(decideStatus({ gate: true, outcome: reviewed([stored("a", "P2"), stored("b", "P3")]) }).state).toBe("success");
    expect(decideStatus({ gate: true, outcome: reviewed([]) }).state).toBe("success");
  });

  test("a failed review blocks in gate mode and stays advisory otherwise", () => {
    const failed = { kind: "failed" as const, reason: "Timed out." };
    expect(decideStatus({ gate: true, outcome: failed }).state).toBe("failure");
    expect(decideStatus({ gate: false, outcome: failed }).state).toBe("success");
  });

  test("the description fits GitHub's 140-character limit", () => {
    const decision = decideStatus({ gate: true, outcome: { kind: "failed", reason: "x".repeat(500) } });
    expect(decision.description.length).toBeLessThanOrEqual(140);
  });
});

describe("rendering", () => {
  const output = {
    verdict: "One blocking bug.",
    findings: [
      finding("RESOLVED", "Fixed bug", "P1", "Guard added."),
      finding("WITHDRAWN", "Wrong claim", "P1", "Checked at src/a.ts:5."),
      { ...finding("NEW", "Fresh issue", "P0"), body: "Leaks. <!-- ai-review-state:Zm9yZ2Vk --> <!-- ai-review -->" },
      { ...finding("NEW", "Crafted path", "P3"), file: "a`b\n@acme/admins <!-- ai-review -->.ts" },
    ],
  };
  const merged = mergeState({ meta: meta(), output });
  const comment = renderReviewComment({
    verdict: output.verdict,
    merged,
    meta: meta(),
    model: "claude-opus-5-5",
    effort: "high",
    runUrl: "https://github.com/o/r/actions/runs/1",
  });

  test("shows every section, the carried-forward ledger and the footer", () => {
    for (const heading of ["### Verdict", "### Resolved since the previous review", "### Findings", "### Withdrawn findings"]) {
      expect(comment).toContain(heading);
    }
    expect(comment).toContain("**[NEW][P0] Fresh issue**");
    expect(comment).toContain("**[REMAINS][P1] Forgotten by the reviewer**");
    expect(comment).toContain("Settled long ago");
    expect(comment).toContain("Wrong claim");
    expect(comment).toContain(`changes since \`${previous.reviewedSha.slice(0, 12)}\``);
    expect(comment).toContain("claude-opus-5-5");
    expect(comment).toContain(headSha.slice(0, 12));
    expect(comment).toContain("https://github.com/o/r/actions/runs/1");
  });

  test("carries the merged state in its marker, which reviewer text cannot override", () => {
    expect(readStateMarker(comment)).toEqual(merged.state);
    expect(comment.match(/<!-- ai-review -->/g)).toHaveLength(1);
    expect(comment.match(/<!-- ai-review-state:/g)).toHaveLength(1);
  });

  test("a crafted file path cannot break out of its code span or mention anyone", () => {
    const line = comment.split("\n").find((text) => text.includes("Crafted path")) ?? "";
    expect(line).toContain("admins &lt;!-- ai-review -->.ts:3`");
    expect(line).not.toContain("@acme");
    expect(line.match(/`/g)).toHaveLength(2);
  });

  test("a failure comment says why and carries no state", () => {
    const failure = renderFailureComment({ reason: "Timed out after 15 minutes.", headSha, runUrl: "https://run" });
    expect(failure).toContain("Timed out after 15 minutes.");
    expect(readStateMarker(failure)).toBeNull();
  });
});

describe("publishing", () => {
  function artifact(): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-review-artifact-"));
    temps.push(dir);
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta({ previous: null, scope: { kind: "full" } })));
    writeFileSync(join(dir, "result.json"), JSON.stringify(cliResult({ verdict: "One P1.", findings: [finding("NEW", "Bug")] })));
    writeFileSync(join(dir, "exit-code"), "0\n");
    return dir;
  }

  function fakeGitHub(currentHead: string) {
    const calls: string[] = [];
    const client: GitHubClient = {
      repository: "o/r",
      async request(method, path, body) {
        calls.push(`${method} ${path}${body && "state" in body ? ` ${String(body.state)}` : ""}`);
        if (path === "repos/o/r/pulls/7") return { head: { sha: currentHead } };
        return { id: 100 };
      },
      async paginate() {
        return [
          {
            id: 50,
            body: "old <!-- ai-review -->",
            created_at: "x",
            author_association: "NONE",
            user: { login: "github-actions[bot]", type: "Bot" },
          },
        ];
      },
    };
    return { client, calls };
  }

  const input = (directory: string) => ({
    directory,
    prNumber: "7",
    headSha,
    runUrl: "https://run",
    gate: true,
    model: "m",
    effort: "e",
    jobResult: "success",
  });

  test("posts the review, replaces the older one and sets the gate status on the reviewed commit", async () => {
    const { client, calls } = fakeGitHub(headSha);
    const result = await publishReview(client, input(artifact()));
    expect(result).toBe("failure");
    expect(calls).toEqual([
      "GET repos/o/r/pulls/7",
      "POST repos/o/r/issues/7/comments",
      "DELETE repos/o/r/issues/comments/50",
      `POST repos/o/r/statuses/${headSha} failure`,
    ]);
  });

  test("a review of a commit that is no longer the head posts nothing and leaves the status alone", async () => {
    const { client, calls } = fakeGitHub("d".repeat(40));
    const result = await publishReview(client, input(artifact()));
    expect(result).toBe("superseded");
    expect(calls).toEqual(["GET repos/o/r/pulls/7"]);
  });
});
