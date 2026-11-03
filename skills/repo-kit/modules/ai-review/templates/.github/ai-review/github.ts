import { type GitHubComment, isRecord } from "./state.ts";

export type GitHubClient = {
  repository: string;
  request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown>;
  paginate(path: string): Promise<unknown[]>;
};

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A client for the REST API with the job's `GITHUB_TOKEN`, scoped to `GITHUB_REPOSITORY`. */
export function githubClientFromEnv(): GitHubClient {
  const token = requireEnv("GITHUB_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };

  const send = async (method: string, url: string, body?: Record<string, unknown>) => {
    const response = await fetch(url, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`${method} ${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  };

  return {
    repository,
    async request(method, path, body) {
      const response = await send(method, `${apiUrl}/${path}`, body);
      if (response.status === 204) return null;
      const data: unknown = await response.json();
      return data;
    },
    async paginate(path) {
      const items: unknown[] = [];
      let url: string | null = `${apiUrl}/${path}${path.includes("?") ? "&" : "?"}per_page=100`;
      while (url) {
        const response = await send("GET", url);
        const page: unknown = await response.json();
        if (!Array.isArray(page)) throw new Error(`GET ${url} did not return a list`);
        items.push(...page);
        url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
      }
      return items;
    },
  };
}

function readComment(value: unknown): GitHubComment | null {
  if (!isRecord(value)) return null;
  const { id, body, created_at, author_association, user } = value;
  if (typeof id !== "number" || typeof created_at !== "string" || typeof author_association !== "string") return null;
  const author =
    isRecord(user) && typeof user.login === "string" && typeof user.type === "string"
      ? { login: user.login, type: user.type }
      : null;
  return { id, body: typeof body === "string" ? body : "", created_at, author_association, user: author };
}

/** Every comment on the pull request's conversation tab, oldest first. */
export async function listPullRequestComments(client: GitHubClient, prNumber: string): Promise<GitHubComment[]> {
  const items = await client.paginate(`repos/${client.repository}/issues/${prNumber}/comments`);
  return items.map(readComment).filter((comment) => comment !== null);
}

/**
 * True only for `admin` and `write`, the roles that can merge (`maintain` reports `write`, `triage` reports `read`).
 * A failed lookup answers false, so an unknown permission never counts.
 */
export async function canMerge(client: GitHubClient, login: string): Promise<boolean> {
  try {
    const data = await client.request(
      "GET",
      `repos/${client.repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return isRecord(data) && (data.permission === "admin" || data.permission === "write");
  } catch {
    return false;
  }
}
