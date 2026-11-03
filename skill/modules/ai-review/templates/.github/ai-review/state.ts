// Shared by collect.ts, compose-prompt.ts and publish.ts. Standard library only: the workflow
// runs these files from a copy taken out of the base commit, outside the pull request checkout.

const BOT_LOGIN = "github-actions[bot]";
export const REVIEW_MARKER = "<!-- ai-review -->";
export const FAILURE_MARKER = "<!-- ai-review-failure -->";
const STATE_MARKER = /<!-- ai-review-state:([A-Za-z0-9+/=]*) -->/g;

const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
type Priority = (typeof PRIORITIES)[number];

const STATUSES = ["NEW", "REMAINS", "RESOLVED", "WITHDRAWN"] as const;
type FindingStatus = (typeof STATUSES)[number];

/** A finding as the state carries it from one review to the next. */
export type StoredFinding = {
  priority: Priority;
  title: string;
  file: string;
  line: number | null;
  body: string;
  reason?: string;
};

/** A finding as the reviewer returns it. */
export type Finding = StoredFinding & { status: FindingStatus };

export type ReviewState = {
  version: 1;
  /** The head commit the review covered. */
  reviewedSha: string;
  /** Findings with status NEW or REMAINS: what the next review must re-classify. */
  active: StoredFinding[];
  /** Every finding withdrawn on this PR, so a settled argument stays settled. */
  withdrawn: StoredFinding[];
  /** When the run read the pull request comments. Later comments are the next run's author responses. */
  responsesReadAt?: string;
};

export type ReviewScope = { kind: "full" } | { kind: "since"; reviewedSha: string };

/** Written by compose-prompt.ts next to the prompt, read by publish.ts. */
export type ReviewMeta = {
  baseSha: string;
  headSha: string;
  scope: ReviewScope;
  previous: ReviewState | null;
  responsesReadAt: string;
  /** Author responses this run passed to the reviewer. A withdrawal needs at least one. */
  responseCount: number;
};

/** An ISO timestamp in GitHub's format (no milliseconds), so it compares as a string with `created_at`. */
export function githubTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type GitHubComment = {
  id: number;
  body: string;
  created_at: string;
  author_association: string;
  user: { login: string; type: string } | null;
};

export function isBotComment(comment: GitHubComment): boolean {
  return comment.user?.login === BOT_LOGIN && comment.user.type === "Bot";
}

/** The identity of a finding across reviews: the reviewer is told to copy the title and file exactly. */
export function findingKey(finding: Pick<StoredFinding, "file" | "title">): string {
  const title = finding.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `${finding.file.trim()}\n${title}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}.${field} must be a non-empty string`);
  return value;
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return options.some((option) => option === value);
}

function readStoredFinding(value: unknown, where: string): StoredFinding {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  if (!isOneOf(PRIORITIES, value.priority))
    throw new Error(`${where}.priority must be one of ${PRIORITIES.join(", ")}`);
  const line = value.line;
  if (line !== null && !(typeof line === "number" && Number.isInteger(line) && line >= 1)) {
    throw new Error(`${where}.line must be a positive integer or null`);
  }
  const finding: StoredFinding = {
    priority: value.priority,
    title: requireText(value, "title", where),
    file: requireText(value, "file", where),
    line,
    body: requireText(value, "body", where),
  };
  if (value.reason !== undefined) finding.reason = requireText(value, "reason", where);
  return finding;
}

export function readFinding(value: unknown, where: string): Finding {
  const stored = readStoredFinding(value, where);
  const status = isRecord(value) ? value.status : undefined;
  if (!isOneOf(STATUSES, status)) throw new Error(`${where}.status must be one of ${STATUSES.join(", ")}`);
  if ((status === "RESOLVED" || status === "WITHDRAWN") && stored.reason === undefined) {
    throw new Error(`${where} is ${status} and needs a reason`);
  }
  return { status, ...stored };
}

export function readState(value: unknown): ReviewState {
  if (!isRecord(value) || value.version !== 1) throw new Error("state must be a version 1 object");
  const reviewedSha = value.reviewedSha;
  if (typeof reviewedSha !== "string" || !/^[0-9a-f]{40}$/.test(reviewedSha))
    throw new Error("state.reviewedSha must be a full SHA");
  const list = (field: string) => {
    const items = value[field];
    if (!Array.isArray(items)) throw new Error(`state.${field} must be an array`);
    return items.map((item, index) => readStoredFinding(item, `state.${field}[${index}]`));
  };
  const state: ReviewState = { version: 1, reviewedSha, active: list("active"), withdrawn: list("withdrawn") };
  if (
    typeof value.responsesReadAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.responsesReadAt)
  ) {
    state.responsesReadAt = value.responsesReadAt;
  }
  return state;
}

/** A hidden HTML comment holding the state as base64 JSON. Base64 cannot contain `-->`, so the marker cannot be closed early. */
export function writeStateMarker(state: ReviewState): string {
  return `<!-- ai-review-state:${Buffer.from(JSON.stringify(state), "utf8").toString("base64")} -->`;
}

/** Reads the last state marker in a comment body, or null when there is none or it does not parse. */
export function readStateMarker(body: string): ReviewState | null {
  const encoded = [...body.matchAll(STATE_MARKER)].at(-1)?.[1];
  if (encoded === undefined) return null;
  try {
    return readState(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
  } catch {
    return null;
  }
}
