// Turns the reviewer's result into a pull request comment and the `AI review` commit status.
// Run by the workflow's publish job from the base commit's copy, with no pull request code checked out.
//
//   node publish.ts --dir <downloaded artifact folder>
//   env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, RUN_URL, MODEL, EFFORT,
//        AI_REVIEW_GATE ("true" blocks merge), REVIEW_JOB_RESULT
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type GitHubClient, githubClientFromEnv, listPullRequestComments, requireEnv } from "./github.ts";
import {
  FAILURE_MARKER,
  type Finding,
  findingKey,
  isBotComment,
  isRecord,
  REVIEW_MARKER,
  type ReviewMeta,
  type ReviewState,
  readFinding,
  readState,
  type StoredFinding,
  writeStateMarker,
} from "./state.ts";

export const STATUS_CONTEXT = "AI review";
const STATUS_DESCRIPTION_LIMIT = 140;

export type ReviewOutput = { verdict: string; findings: Finding[] };
export type ReviewResult = { ok: true; output: ReviewOutput } | { ok: false; reason: string };
export type ReviewOutcome = { kind: "reviewed"; active: StoredFinding[] } | { kind: "failed"; reason: string };

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Validates the JSON that `claude --print --output-format json --json-schema` wrote. */
export function readReviewResult(raw: unknown): ReviewResult {
  const result = Array.isArray(raw) ? raw.findLast((event) => isRecord(event) && event.type === "result") : raw;
  if (!isRecord(result)) return { ok: false, reason: "Claude Code wrote no result." };
  if (result.is_error !== false || result.subtype !== "success") {
    const detail = typeof result.result === "string" ? `: ${oneLine(result.result, 200)}` : "";
    return { ok: false, reason: `Claude Code reported ${String(result.subtype ?? "an error")}${detail}` };
  }
  const output = result.structured_output;
  if (!isRecord(output)) return { ok: false, reason: "The reviewer returned no structured output." };
  try {
    if (typeof output.verdict !== "string" || output.verdict.trim() === "")
      throw new Error("verdict must be a non-empty string");
    if (!Array.isArray(output.findings)) throw new Error("findings must be an array");
    return {
      ok: true,
      output: {
        verdict: output.verdict,
        findings: output.findings.map((item, index) => readFinding(item, `findings[${index}]`)),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `The reviewer returned malformed output: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

const stripStatus = ({ status: _status, ...finding }: Finding): StoredFinding => finding;

/**
 * The state the next review starts from. A previous active finding the reviewer skipped stays active,
 * so a P0 cannot leave the gate by being forgotten. Withdrawals accumulate for the life of the PR.
 */
export function mergeState(input: {
  previous: ReviewState | null;
  output: ReviewOutput;
  headSha: string;
  responsesReadAt: string;
}): {
  state: ReviewState;
  unclassified: StoredFinding[];
} {
  const { previous, output, headSha, responsesReadAt } = input;
  const classified = new Set(output.findings.map(findingKey));
  const unclassified = (previous?.active ?? []).filter((finding) => !classified.has(findingKey(finding)));

  const withdrawn = [...(previous?.withdrawn ?? [])];
  const ledger = new Set(withdrawn.map(findingKey));
  for (const finding of output.findings) {
    if (finding.status !== "WITHDRAWN" || ledger.has(findingKey(finding))) continue;
    ledger.add(findingKey(finding));
    withdrawn.push(stripStatus(finding));
  }

  const active = [
    ...output.findings.filter((finding) => finding.status === "NEW" || finding.status === "REMAINS").map(stripStatus),
    ...unclassified,
  ];
  return { state: { version: 1, reviewedSha: headSha, active, withdrawn, responsesReadAt }, unclassified };
}

const isBlocking = (finding: StoredFinding) => finding.priority === "P0" || finding.priority === "P1";

/** Advisory mode always reports success; gate mode fails on an active P0/P1 or on a review that did not complete. */
export function decideStatus(input: { gate: boolean; outcome: ReviewOutcome }): {
  state: "success" | "failure";
  description: string;
} {
  const { gate, outcome } = input;
  const suffix = gate ? "" : " (advisory)";
  if (outcome.kind === "failed") {
    return {
      state: gate ? "failure" : "success",
      description: oneLine(`Review did not complete${suffix}: ${outcome.reason}`, STATUS_DESCRIPTION_LIMIT),
    };
  }
  const blocking = outcome.active.filter(isBlocking).length;
  const total = outcome.active.length;
  if (total === 0) return { state: "success", description: `No open findings${suffix}` };
  const counts = `${total} open finding${total === 1 ? "" : "s"}, ${blocking} P0/P1`;
  if (gate && blocking > 0) return { state: "failure", description: `${counts}: fix them or rebut with /ai-review` };
  return { state: "success", description: `${counts}${suffix}` };
}

/** Reviewer text is untrusted: it must not open an HTML comment (a forged marker) or mention people. */
function neutralize(text: string): string {
  return text.replaceAll("<!--", "&lt;!--").replace(/@(?=[A-Za-z0-9])/g, "@⁠");
}

function location(finding: StoredFinding): string {
  return finding.line === null ? `\`${finding.file}\`` : `\`${finding.file}:${finding.line}\``;
}

function item(index: number, label: string, finding: StoredFinding, text: string): string {
  const detail = neutralize(text).trim().replace(/\n/g, "\n   ");
  return `${index + 1}. **[${label}][${finding.priority}] ${neutralize(oneLine(finding.title, 200))}** - ${location(finding)}\n   ${detail}`;
}

function list(entries: string[], empty: string): string {
  return entries.length === 0 ? empty : entries.join("\n\n");
}

export function renderReviewComment(input: {
  output: ReviewOutput;
  merged: { state: ReviewState; unclassified: StoredFinding[] };
  meta: ReviewMeta;
  model: string;
  effort: string;
  runUrl: string;
}): string {
  const { output, merged, meta } = input;
  const resolved = output.findings.filter((finding) => finding.status === "RESOLVED");
  const open = [
    ...output.findings
      .filter((finding) => finding.status === "NEW" || finding.status === "REMAINS")
      .map((finding) => ({ label: finding.status, finding, text: finding.body })),
    ...merged.unclassified.map((finding) => ({
      label: "REMAINS",
      finding,
      text: `${finding.body}\n_Carried forward unchanged: this review did not recheck it._`,
    })),
  ];
  const scope =
    meta.scope.kind === "since" ? `changes since \`${meta.scope.reviewedSha.slice(0, 12)}\`` : "full pull request";

  return [
    "## AI review",
    "",
    "### Verdict",
    "",
    neutralize(output.verdict.trim()),
    "",
    "### Resolved since the previous review",
    "",
    list(
      resolved.map((finding, index) => item(index, "RESOLVED", finding, finding.reason ?? "")),
      "None.",
    ),
    "",
    "### Findings",
    "",
    list(
      open.map((entry, index) => item(index, entry.label, entry.finding, entry.text)),
      "No actionable findings.",
    ),
    "",
    "### Withdrawn findings",
    "",
    list(
      merged.state.withdrawn.map((finding, index) => item(index, "WITHDRAWN", finding, finding.reason ?? "")),
      "None.",
    ),
    "",
    "---",
    `<sub>Commit \`${meta.headSha.slice(0, 12)}\` · Scope: ${scope} · Model: ${input.model} (effort ${input.effort}) · [Workflow run](${input.runUrl})</sub>`,
    "",
    "> A finding is wrong? Reply with the concrete reason (the line, guard or contract that disproves it) and include `/ai-review` in the same comment. The reviewer rechecks it against the code and withdraws it when the reason holds. A push re-runs the review on its own.",
    "",
    writeStateMarker(merged.state),
    REVIEW_MARKER,
    "",
  ].join("\n");
}

export function renderFailureComment(input: { reason: string; headSha: string; runUrl: string }): string {
  return [
    "## AI review did not complete",
    "",
    `Commit \`${input.headSha.slice(0, 12)}\` was not reviewed. ${neutralize(input.reason)}`,
    "",
    `The latest successful review, if there is one, stays above. [Workflow run](${input.runUrl})`,
    "",
    FAILURE_MARKER,
    "",
  ].join("\n");
}

function readMeta(value: unknown): ReviewMeta {
  const sha = (field: unknown, name: string) => {
    if (typeof field !== "string" || !/^[0-9a-f]{40}$/.test(field)) throw new Error(`meta.${name} must be a full SHA`);
    return field;
  };
  if (!isRecord(value) || !isRecord(value.scope)) throw new Error("meta.json is malformed");
  const scope =
    value.scope.kind === "since"
      ? { kind: "since" as const, reviewedSha: sha(value.scope.reviewedSha, "scope.reviewedSha") }
      : { kind: "full" as const };
  if (typeof value.responsesReadAt !== "string") throw new Error("meta.responsesReadAt must be a timestamp");
  return {
    baseSha: sha(value.baseSha, "baseSha"),
    headSha: sha(value.headSha, "headSha"),
    scope,
    previous: value.previous === null ? null : readState(value.previous),
    responsesReadAt: value.responsesReadAt,
  };
}

/** A missing file or one that is not JSON (Claude Code can die before writing) reads as null. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

type Outcome = { kind: "reviewed"; meta: ReviewMeta; output: ReviewOutput } | { kind: "failed"; reason: string };

function readOutcome(directory: string, jobResult: string): Outcome {
  if (!existsSync(join(directory, "meta.json"))) {
    return { kind: "failed", reason: `The review job stopped before the reviewer ran (job result: ${jobResult}).` };
  }
  let meta: ReviewMeta;
  try {
    meta = readMeta(readJson(join(directory, "meta.json")));
  } catch (error) {
    return {
      kind: "failed",
      reason: `The review job wrote unreadable metadata: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  const exitCode = existsSync(join(directory, "exit-code"))
    ? readFileSync(join(directory, "exit-code"), "utf8").trim()
    : "";
  if (exitCode === "124") return { kind: "failed", reason: "The reviewer timed out after 15 minutes." };
  const result = readReviewResult(readJson(join(directory, "result.json")));
  if (result.ok) return { kind: "reviewed", meta, output: result.output };
  return {
    kind: "failed",
    reason: exitCode && exitCode !== "0" ? `Claude Code exited with code ${exitCode}. ${result.reason}` : result.reason,
  };
}

async function replaceComment(client: GitHubClient, prNumber: string, body: string, replaces: string[]): Promise<void> {
  const created = await client.request("POST", `repos/${client.repository}/issues/${prNumber}/comments`, { body });
  const createdId = isRecord(created) && typeof created.id === "number" ? created.id : Number.POSITIVE_INFINITY;
  const stale = (await listPullRequestComments(client, prNumber)).filter(
    (comment) =>
      isBotComment(comment) && comment.id < createdId && replaces.some((marker) => comment.body.includes(marker)),
  );
  for (const comment of stale) {
    try {
      await client.request("DELETE", `repos/${client.repository}/issues/comments/${comment.id}`);
    } catch (error) {
      console.warn(
        `Could not delete old review comment ${comment.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function publish(directory: string): Promise<"success" | "failure"> {
  const client = githubClientFromEnv();
  const prNumber = requireEnv("PR_NUMBER");
  const headSha = requireEnv("HEAD_SHA");
  const runUrl = requireEnv("RUN_URL");
  const gate = process.env.AI_REVIEW_GATE === "true";

  let outcome: ReviewOutcome;
  const read = readOutcome(directory, process.env.REVIEW_JOB_RESULT ?? "unknown");
  try {
    if (read.kind === "reviewed") {
      const merged = mergeState({
        previous: read.meta.previous,
        output: read.output,
        headSha,
        responsesReadAt: read.meta.responsesReadAt,
      });
      const body = renderReviewComment({
        output: read.output,
        merged,
        meta: read.meta,
        model: requireEnv("MODEL"),
        effort: requireEnv("EFFORT"),
        runUrl,
      });
      await replaceComment(client, prNumber, body, [REVIEW_MARKER, FAILURE_MARKER]);
      outcome = { kind: "reviewed", active: merged.state.active };
    } else {
      await replaceComment(client, prNumber, renderFailureComment({ reason: read.reason, headSha, runUrl }), [
        FAILURE_MARKER,
      ]);
      outcome = read;
    }
  } catch (error) {
    outcome = {
      kind: "failed",
      reason: `The review comment could not be published: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const decision = decideStatus({ gate, outcome });
  await client.request("POST", `repos/${client.repository}/statuses/${headSha}`, {
    state: decision.state,
    context: STATUS_CONTEXT,
    description: decision.description,
    target_url: runUrl,
  });
  console.log(`${STATUS_CONTEXT}: ${decision.state} - ${decision.description}`);
  return decision.state;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dir: { type: "string" } } });
  if (!values.dir) {
    console.error("usage: node publish.ts --dir <artifact folder>");
    process.exit(2);
  }
  if ((await publish(values.dir)) === "failure") process.exit(1);
}
