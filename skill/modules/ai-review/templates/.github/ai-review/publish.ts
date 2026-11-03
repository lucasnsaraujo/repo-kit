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

const STATUS_CONTEXT = "AI review";
const STATUS_DESCRIPTION_LIMIT = 140;

type ReviewOutput = { verdict: string; findings: Finding[] };
type ReviewResult = { ok: true; output: ReviewOutput } | { ok: false; reason: string };
type ReviewOutcome = { kind: "reviewed"; active: StoredFinding[] } | { kind: "failed"; reason: string };

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
    const findings = output.findings.map((item, index) => readFinding(item, `findings[${index}]`));
    return { ok: true, output: { verdict: output.verdict, findings } };
  } catch (error) {
    return { ok: false, reason: `The reviewer returned malformed output: ${errorText(error)}.` };
  }
}

const stripStatus = ({ status: _status, ...finding }: Finding): StoredFinding => finding;

type OpenFinding = { status: "NEW" | "REMAINS"; finding: StoredFinding; note?: string };
type MergedReview = { state: ReviewState; open: OpenFinding[]; resolved: StoredFinding[] };

/**
 * The review to publish and the state the next one starts from. The reviewer's word is not final:
 * a previous finding it skipped stays open, so a P0 cannot leave the gate by being forgotten; a
 * withdrawal needs an author response in this run; and RESOLVED or WITHDRAWN only count for a
 * finding the last review raised. Withdrawals accumulate for the life of the pull request.
 */
export function mergeState(input: { meta: ReviewMeta; output: ReviewOutput }): MergedReview {
  const { meta, output } = input;
  const previousActive = new Map((meta.previous?.active ?? []).map((finding) => [findingKey(finding), finding]));
  const withdrawn = [...(meta.previous?.withdrawn ?? [])];
  const ledger = new Set(withdrawn.map(findingKey));
  const open: OpenFinding[] = [];
  const resolved: StoredFinding[] = [];
  const classified = new Set<string>();

  for (const finding of output.findings) {
    const key = findingKey(finding);
    if (finding.status === "NEW" || finding.status === "REMAINS") {
      classified.add(key);
      open.push({ status: finding.status, finding: stripStatus(finding) });
      continue;
    }
    const earlier = previousActive.get(key);
    if (!earlier) continue;
    classified.add(key);
    if (finding.status === "RESOLVED") resolved.push(stripStatus(finding));
    else if (meta.responseCount === 0) {
      open.push({
        status: "REMAINS",
        finding: earlier,
        note: "Kept: the reviewer withdrew it, but no author response reached this run.",
      });
    } else if (!ledger.has(key)) {
      ledger.add(key);
      withdrawn.push(stripStatus(finding));
    }
  }
  for (const [key, finding] of previousActive) {
    if (!classified.has(key))
      open.push({ status: "REMAINS", finding, note: "Carried forward unchanged: this review did not recheck it." });
  }

  const state: ReviewState = {
    version: 1,
    reviewedSha: meta.headSha,
    active: open.map((entry) => entry.finding),
    withdrawn,
    responsesReadAt: meta.responsesReadAt,
  };
  return { state, open, resolved };
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
  const file = neutralize(finding.file.replace(/[`\r\n]/g, ""));
  return finding.line === null ? `\`${file}\`` : `\`${file}:${finding.line}\``;
}

function item(index: number, label: string, finding: StoredFinding, text: string): string {
  const detail = neutralize(text).trim().replace(/\n/g, "\n   ");
  return `${index + 1}. **[${label}][${finding.priority}] ${neutralize(oneLine(finding.title, 200))}** - ${location(finding)}\n   ${detail}`;
}

function list(entries: string[], empty: string): string {
  return entries.length === 0 ? empty : entries.join("\n\n");
}

export function renderReviewComment(input: {
  verdict: string;
  merged: MergedReview;
  meta: ReviewMeta;
  model: string;
  effort: string;
  runUrl: string;
}): string {
  const { merged, meta } = input;
  const scope =
    meta.scope.kind === "since" ? `changes since \`${meta.scope.reviewedSha.slice(0, 12)}\`` : "full pull request";
  const open = merged.open.map((entry, index) =>
    item(
      index,
      entry.status,
      entry.finding,
      entry.note ? `${entry.finding.body}\n_${entry.note}_` : entry.finding.body,
    ),
  );

  return [
    "## AI review",
    "",
    "### Verdict",
    "",
    neutralize(input.verdict.trim()),
    "",
    "### Resolved since the previous review",
    "",
    list(
      merged.resolved.map((finding, index) => item(index, "RESOLVED", finding, finding.reason ?? "")),
      "None.",
    ),
    "",
    "### Findings",
    "",
    list(open, "No actionable findings."),
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
    "> A finding is wrong? Reply with the concrete reason (the line, guard or contract that disproves it) and start a line of that comment with `/ai-review`. The reviewer rechecks it against the code and withdraws it when the reason holds. A push re-runs the review on its own.",
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
  if (typeof value.responseCount !== "number") throw new Error("meta.responseCount must be a number");
  return {
    baseSha: sha(value.baseSha, "baseSha"),
    headSha: sha(value.headSha, "headSha"),
    scope,
    previous: value.previous === null ? null : readState(value.previous),
    responsesReadAt: value.responsesReadAt,
    responseCount: value.responseCount,
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

function readOutcome(directory: string, headSha: string, jobResult: string): Outcome {
  if (!existsSync(join(directory, "meta.json"))) {
    return { kind: "failed", reason: `The review job stopped before the reviewer ran (job result: ${jobResult}).` };
  }
  let meta: ReviewMeta;
  try {
    meta = readMeta(readJson(join(directory, "meta.json")));
  } catch (error) {
    return { kind: "failed", reason: `The review job wrote unreadable metadata: ${errorText(error)}.` };
  }
  if (meta.headSha !== headSha)
    return { kind: "failed", reason: `The review job reviewed ${meta.headSha}, not ${headSha}.` };
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
      console.warn(`Could not delete old review comment ${comment.id}: ${errorText(error)}`);
    }
  }
}

async function currentHeadSha(client: GitHubClient, prNumber: string): Promise<string | null> {
  try {
    const pull = await client.request("GET", `repos/${client.repository}/pulls/${prNumber}`);
    return isRecord(pull) && isRecord(pull.head) && typeof pull.head.sha === "string" ? pull.head.sha : null;
  } catch {
    return null;
  }
}

/**
 * Posts the comment and the status for one review. A review of a commit that is no longer the head
 * (a comment run that finished after a newer push) publishes nothing, so it cannot replace the newer review.
 */
export async function publishReview(
  client: GitHubClient,
  input: {
    directory: string;
    prNumber: string;
    headSha: string;
    runUrl: string;
    gate: boolean;
    model: string;
    effort: string;
    jobResult: string;
  },
): Promise<"success" | "failure" | "superseded"> {
  const { prNumber, headSha, runUrl } = input;
  const head = await currentHeadSha(client, prNumber);
  if (head !== null && head !== headSha) {
    console.log(`Not publishing: the review covered ${headSha}, but the pull request head is now ${head}.`);
    return "superseded";
  }

  let outcome: ReviewOutcome;
  const read = readOutcome(input.directory, headSha, input.jobResult);
  try {
    if (read.kind === "reviewed") {
      const merged = mergeState({ meta: read.meta, output: read.output });
      const body = renderReviewComment({
        verdict: read.output.verdict,
        merged,
        meta: read.meta,
        model: input.model,
        effort: input.effort,
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
    outcome = { kind: "failed", reason: `The review comment could not be published: ${errorText(error)}` };
  }

  const decision = decideStatus({ gate: input.gate, outcome });
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
  const result = await publishReview(githubClientFromEnv(), {
    directory: values.dir,
    prNumber: requireEnv("PR_NUMBER"),
    headSha: requireEnv("HEAD_SHA"),
    runUrl: requireEnv("RUN_URL"),
    gate: process.env.AI_REVIEW_GATE === "true",
    model: requireEnv("MODEL"),
    effort: requireEnv("EFFORT"),
    jobResult: process.env.REVIEW_JOB_RESULT ?? "unknown",
  });
  if (result === "failure") process.exit(1);
}
