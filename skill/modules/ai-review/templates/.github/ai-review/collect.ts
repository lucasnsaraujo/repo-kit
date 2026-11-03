// Gathers what the next review carries forward: the previous review's state and the author
// responses written since. Run by the workflow's review job; writes one JSON file.
//
//   node collect.ts --out <file>
//   env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, TRIGGER_COMMENT_ID (optional)
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { canMerge, githubClientFromEnv, listPullRequestComments, requireEnv } from "./github.ts";
import {
  type GitHubComment,
  githubTimestamp,
  isBotComment,
  isRecord,
  type ReviewState,
  readState,
  readStateMarker,
} from "./state.ts";

export type PreviousReview = { commentId: number; createdAt: string; state: ReviewState };
export type AuthorResponse = { login: string; createdAt: string; body: string };

export type ReviewContext = {
  title: string;
  body: string;
  previous: PreviousReview | null;
  responses: AuthorResponse[];
  omittedResponses: number;
  /** When the comments were read; the next review takes author responses from this moment on. */
  readAt: string;
};

const RESPONSES_CAP_BYTES = 20_000;
const PRE_FILTER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The newest comment by the workflow's bot that carries a readable state. A marker from anyone else is ignored. */
export function findPreviousReview(comments: GitHubComment[]): PreviousReview | null {
  for (const comment of [...comments].reverse()) {
    if (!isBotComment(comment)) continue;
    const state = readStateMarker(comment.body);
    if (state) return { commentId: comment.id, createdAt: comment.created_at, state };
  }
  return null;
}

/** Replies count from when the previous run read the comments, so a reply posted while that run worked is not lost. */
export function responsesSince(previous: PreviousReview | null): string | null {
  return previous ? (previous.state.responsesReadAt ?? previous.createdAt) : null;
}

type ResponseWindow = { since: string | null; triggerId: number | null };

function inWindow(comment: GitHubComment, { since, triggerId }: ResponseWindow): boolean {
  return comment.id === triggerId || since === null || comment.created_at > since;
}

/**
 * Logins whose permission is worth looking up: people (not bots) with an association to the repository
 * who commented inside the window. The association is only a pre-filter: `MEMBER` and `COLLABORATOR`
 * include people who cannot merge, so each candidate is checked with the permission API.
 */
export function rebuttalCandidates(comments: GitHubComment[], window: ResponseWindow): string[] {
  const logins = comments
    .filter(
      (comment) =>
        comment.user && comment.user.type !== "Bot" && PRE_FILTER_ASSOCIATIONS.has(comment.author_association),
    )
    .filter((comment) => inWindow(comment, window))
    .map((comment) => comment.user?.login ?? "");
  return [...new Set(logins)].sort();
}

/**
 * The triggering comment first and whole, then the rest newest first. Older replies are dropped once
 * the cap is reached, because the newest ones answer the review being carried forward.
 */
export function selectAuthorResponses(
  comments: GitHubComment[],
  options: ResponseWindow & { permitted: Set<string>; capBytes: number },
): { responses: AuthorResponse[]; omitted: number } {
  const eligible = comments.filter(
    (comment) =>
      comment.user &&
      comment.user.type !== "Bot" &&
      options.permitted.has(comment.user.login) &&
      inWindow(comment, options),
  );
  const trigger = eligible.find((comment) => comment.id === options.triggerId);
  const rest = eligible
    .filter((comment) => comment !== trigger)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);

  const toResponse = (comment: GitHubComment): AuthorResponse => ({
    login: comment.user?.login ?? "",
    createdAt: comment.created_at,
    body: comment.body,
  });
  const responses = trigger ? [toResponse(trigger)] : [];
  let used = trigger ? Buffer.byteLength(trigger.body) : 0;
  let omitted = 0;
  for (const comment of rest) {
    const size = Buffer.byteLength(comment.body);
    if (omitted > 0 || used + size > options.capBytes) {
      omitted += 1;
      continue;
    }
    responses.push(toResponse(comment));
    used += size;
  }
  return { responses, omitted };
}

/** Reads the file `collect` wrote back into its type, rejecting anything else. */
export function readContext(value: unknown): ReviewContext {
  if (!isRecord(value)) throw new Error("review context must be an object");
  const { title, body, previous, responses, omittedResponses, readAt } = value;
  if (
    typeof title !== "string" ||
    typeof body !== "string" ||
    !Array.isArray(responses) ||
    typeof omittedResponses !== "number" ||
    typeof readAt !== "string"
  ) {
    throw new Error("review context is malformed");
  }
  let previousReview: PreviousReview | null = null;
  if (previous !== null) {
    if (!isRecord(previous) || typeof previous.commentId !== "number" || typeof previous.createdAt !== "string") {
      throw new Error("review context has a malformed previous review");
    }
    previousReview = { commentId: previous.commentId, createdAt: previous.createdAt, state: readState(previous.state) };
  }
  return {
    title,
    body,
    previous: previousReview,
    responses: responses.map((response, index) => {
      if (
        !isRecord(response) ||
        typeof response.login !== "string" ||
        typeof response.createdAt !== "string" ||
        typeof response.body !== "string"
      ) {
        throw new Error(`review context response ${index} is malformed`);
      }
      return { login: response.login, createdAt: response.createdAt, body: response.body };
    }),
    omittedResponses,
    readAt,
  };
}

function parseTriggerId(raw: string | undefined): number | null {
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

async function collect(): Promise<ReviewContext> {
  const client = githubClientFromEnv();
  const prNumber = requireEnv("PR_NUMBER");
  const pull = await client.request("GET", `repos/${client.repository}/pulls/${prNumber}`);
  const title = isRecord(pull) ? pull.title : undefined;
  const body = isRecord(pull) ? pull.body : undefined;

  const readAt = githubTimestamp(new Date());
  const comments = await listPullRequestComments(client, prNumber);
  const previous = findPreviousReview(comments);
  const window: ResponseWindow = {
    since: responsesSince(previous),
    triggerId: parseTriggerId(process.env.TRIGGER_COMMENT_ID),
  };

  const permitted = new Set<string>();
  for (const login of rebuttalCandidates(comments, window)) {
    if (await canMerge(client, login)) permitted.add(login);
    else console.log(`Ignoring comments from @${login}: they cannot merge, so their replies are not rebuttals.`);
  }
  const { responses, omitted } = selectAuthorResponses(comments, {
    ...window,
    permitted,
    capBytes: RESPONSES_CAP_BYTES,
  });

  return {
    title: typeof title === "string" ? title : "",
    body: typeof body === "string" ? body : "",
    previous,
    responses,
    omittedResponses: omitted,
    readAt,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (!values.out) {
    console.error("usage: node collect.ts --out <file>");
    process.exit(2);
  }
  const context = await collect();
  writeFileSync(values.out, `${JSON.stringify(context, null, 2)}\n`);
  console.log(
    `Previous review: ${context.previous ? `comment ${context.previous.commentId} at ${context.previous.state.reviewedSha}` : "none"}. ` +
      `Author responses: ${context.responses.length} (${context.omittedResponses} omitted at the size cap).`,
  );
}
