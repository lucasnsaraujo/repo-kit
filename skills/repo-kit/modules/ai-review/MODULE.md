# ai-review

## Sets up

- `.github/workflows/ai-review.yml`: `authorize` filters the event and checks permissions, `review` runs Claude Code headless with no write token, `publish` posts the comment and the `AI review` commit status from a base-commit copy of the kit. `skip-dependabot` marks Dependabot's own pushes `AI review: success` ("Not reviewed: dependency update by Dependabot"): those runs get no secrets, so they cannot be reviewed, and a required status would hold them forever. A human push to a Dependabot branch is reviewed as usual.
- Triggers: every push to a same-repository, non-draft pull request; a pull request comment with a line that starts with `/ai-review`, from someone with admin or write access (forks included). Quoting the bot's comment does not start a run.
- `.github/ai-review/prompt.md`: the reviewer's instructions. `schema.json`: the structured output it must return.
- `.github/ai-review/rules/*.md`: domain rules with `include:` globs; a rule joins the prompt only when the pull request touches a matching file. Ships `tests.md`, `security.md`, `migrations.md`.
- `.github/ai-review/compose-prompt.ts`: builds the trusted system prompt (prompt, `AGENTS.md` files from the base commit, matching rules, review scope) and the untrusted user message (title, description, diff, previous findings, author responses). It also writes each changed file's diff and its fork-point version under a folder outside the checkout. The reviewer's only tools are Read, Grep and Glob over the checkout and that folder: no shell, no git. Diffs read `.gitattributes` from the base commit, so a pull request cannot hide a file as binary.
- `.github/ai-review/collect.ts`: reads the previous review's state and the author responses from the pull request comments.
- `.github/ai-review/publish.ts`: validates the result, renders the comment, replaces the older one, sets the status. A review that finishes after a newer push publishes nothing.
- `state.ts`, `github.ts`: shared types, the state marker and the REST client. All scripts are stdlib-only and run as `node <file>.ts` on Node 24. `.github/ai-review/package.json` marks them as ES modules, so a root `"type": "commonjs"` cannot break them.
- Model `claude-opus-5-5` at effort `high`, overridable with the repository variables `AI_REVIEW_MODEL` and `AI_REVIEW_EFFORT`. Gate mode with `AI_REVIEW_GATE=true`; otherwise advisory.

### Review comment contract

Other tools (the `babysit` skill) rely on these. Change them only together with their readers.

- **Latest review**: the newest comment by `github-actions[bot]` whose body contains `<!-- ai-review -->`. Each run posts a new comment and deletes the older ones, so there is at most one.
- **Failure notice**: a bot comment containing `<!-- ai-review-failure -->` means the newest run did not complete. The latest successful review stays in place.
- **State**: the review comment carries `<!-- ai-review-state:<base64 JSON> -->`. The JSON is `{ "version": 1, "reviewedSha": "<40 hex>", "active": [Finding], "withdrawn": [Finding], "responsesReadAt": "<ISO time>" }` with `Finding = { priority: "P0".."P3", title, file, line: number | null, body, reason? }`. `reviewedSha` is the head commit that review covered; a review is stale when it differs from the pull request head. Markers in comments from anyone but the bot are ignored.
- **Rendered sections**, in order: `### Verdict`, `### Resolved since the previous review`, `### Findings`, `### Withdrawn findings`. Each item reads `N. **[STATUS][Pn] Title** - \`file:line\`` with STATUS one of NEW, REMAINS, RESOLVED, WITHDRAWN.
- **Commit status**: context `AI review` on the head commit. Advisory mode always reports `success` (the description counts open findings and P0/P1); gate mode reports `failure` while a P0 or P1 is open or when the review did not complete.
- **Rebuttal**: a pull request comment from someone with admin or write access. Every such comment posted after the latest review read the comments (`responsesReadAt`) reaches the next review as an author response (the triggering comment first and whole, the rest newest first, 20 KB in total). Comments from bots and from people without write access are ignored. Write one line per finding, with a reason the reviewer can check in the code:

  ```
  P1 <exact finding title>: wrong, <guard or contract> at `path/to/file.ts:42`.
  ```

  An assertion, a promise to fix later or a disagreement about priority keeps the finding as REMAINS. `publish.ts` accepts a withdrawal only when the run had at least one author response, and RESOLVED or WITHDRAWN only for a finding the previous review listed as active.
- **Re-running**: a push re-runs the review on its own and reads every rebuttal posted since the last review, so post the rebuttal first, then push, with no `/ai-review` line. With nothing to push, put `/ai-review` at the start of its own line in the rebuttal to ask for a recheck. A run takes about 3 to 15 minutes and stops at 15. A recheck that finishes after a newer push posts nothing and leaves the status alone; the push's own review covers the new head.

Read the latest state from a shell:

```sh
id=$(gh api --paginate "repos/{owner}/{repo}/issues/$PR/comments" \
  --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- ai-review -->"))) | .id' | tail -1)
gh api "repos/{owner}/{repo}/issues/comments/$id" --jq .body \
  | sed -n 's/.*<!-- ai-review-state:\([A-Za-z0-9+/=]*\) -->.*/\1/p' | base64 -d
```

## Tailor

1. Merge every `*.repo-kit-new` file under `.github/ai-review/` and `.github/workflows/` into its target, keeping local rule edits. Done when `git ls-files --others --exclude-standard | grep repo-kit-new` prints nothing.
2. Check that a root `AGENTS.md` exists: the reviewer reads it, and every `AGENTS.md` above a changed file, as repository instructions. When it is missing, recommend the `agent-docs` module to the owner. Done when `git ls-files AGENTS.md` prints it, or the owner has declined.
3. Find the 1 to 3 riskiest areas of this repository: where a bug loses data, leaks access, takes money, or breaks a released contract (auth, billing, migrations, public API, queues, deploy config). For each, write `.github/ai-review/rules/<area>.md`:
   - front matter `include:` globs that match the real paths of that area;
   - a `### <Area>` heading and one line on why the area is risky;
   - `Report when the diff:` with failure modes specific to this code, naming its real files, functions or invariants;
   - `Do not report:` with the false positives this code invites (frozen copies, intentional duplication, generated files).

   Done when `node .github/ai-review/compose-prompt.ts --check-rules` shows at least one tracked file for each new rule, and each list names at least one real path or function of this repository.
4. Adjust the globs of the shipped `security.md` and `migrations.md` to the repository's layout (for example `app/api/**`, `supabase/migrations/**`). Done when `--check-rules` lists the files you expect for each.
5. Keep the kit's scripts out of the way of the project's checks. They use `.ts` import extensions and top-level `await`, and export functions that only tests use. Exclude `.github/ai-review/` from the project's typecheck, lint and dead-code tools when those would flag it. Done when the project's lint, typecheck and dead-code commands pass.

## Owner steps

1. Create a long-lived token from the Claude subscription and store it as a secret. Reviews count against the owner's plan usage limits, at the configured model and effort, on every push to every open pull request.

   ```sh
   claude setup-token
   gh secret set CLAUDE_CODE_OAUTH_TOKEN
   ```

2. Start in advisory mode: the status is always green and the comment shows the findings.

   ```sh
   gh variable set AI_REVIEW_GATE --body false
   ```

3. After a week or two of reviews, once the P0/P1 findings have proven right, turn the gate on. Requiring the `AI review` status on the default branch is part of the `ci` module's single branch-protection owner step, which lists `AI review` when this module is selected; run that step rather than adding a second rule here. Fork pull requests get no automatic review, so a maintainer comments `/ai-review` on them before they can merge.

   ```sh
   gh variable set AI_REVIEW_GATE --body true
   ```

4. Optional: pick another model or effort.

   ```sh
   gh variable set AI_REVIEW_MODEL --body claude-opus-5-5
   gh variable set AI_REVIEW_EFFORT --body high
   ```

## Verify

- `actionlint .github/workflows/ai-review.yml` prints nothing and exits 0.
- `node .github/ai-review/compose-prompt.ts --base HEAD~1 --head HEAD --files /tmp/ai-review-files` (Node 22.18 or later, git 2.40 or later) prints the instructions, then `## Repository instructions` when an `AGENTS.md` exists, `## Domain rules` when the last commit touched a rule's files, `## Review scope` with `Review the whole pull request` and the folder paths, and after `===== user message (stdin) =====` a `## PR context` with the diff inlined. `/tmp/ai-review-files/pr/` holds one `<path>.diff` per changed file.
- `node .github/ai-review/compose-prompt.ts --check-rules` lists a match count for every rule.
- On a real pull request: within 15 minutes of a push, the Actions run `AI review` is green, the pull request has one comment from `github-actions[bot]` starting with `## AI review`, and `gh pr checks <number>` lists `AI review`. A comment whose first line is `/ai-review` starts a new run that replaces the comment.

## Prior art

- **openbot** `.github/workflows/norbiai-review.yml`, `scripts/compose-review-prompt.ts`, `.github/review/*.md`: prompt, composer and rule fragments read from the base commit; `AGENTS.md` per touched directory; incremental scope since the last reviewed commit, only when it sits between base and head; NEW/REMAINS/RESOLVED/WITHDRAWN with a withdrawn ledger; rebuttals only from people who can merge, checked once per login and failing closed; a private concurrency group per comment run; post-new-then-delete-old comments; a commit status instead of a check run, because comment runs attach their checks to the default branch. Departures: state travels as a base64 JSON marker instead of markdown sections parsed back with awk; the reviewer returns schema-checked JSON (`--json-schema`) instead of markdown; `publish.ts` carries the withdrawn ledger and any previous finding the reviewer skipped, instead of trusting the model to repeat them; GitHub-hosted runners with a subscription token instead of a self-hosted runner; no label trigger, so there is one way to ask for a recheck.
- **astral-sh/uv** `pull-request-code-quality-review.yml`: the model runs in a job without write permissions and an output schema; a separate job with the write token posts the result.
- **DataDog/documentation** `claude_review.yml`: the gate is a commit status; third-party actions pinned by commit SHA.
- **anthropics/claude-code-action** `docs/security.md`: only users with write access can trigger runs; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` keeps secrets out of tool subprocesses; no `pull_request_target` checkout of pull request code. Departure from openbot's Bash allow list: Claude Code's permissions docs (code.claude.com/docs/en/permissions) say its built-in read-only commands (`cat`, `find`, read-only `git`) run without a prompt in every mode, so the reviewer gets no Bash at all and `permissions.blockReadsOutsideWorkingDirectories` keeps Read, Grep and Glob inside the checkout and the diff folder.
- **GitHub Dependabot docs** (troubleshooting Dependabot on GitHub Actions): Dependabot's `pull_request` runs get no secrets and a read-only token that the `permissions` key can raise, which is how `skip-dependabot` reports its status without a `pull_request_target` trigger.
- **Codex code review**: the P0 to P3 scale, with merge blocked only on P0 and P1.
