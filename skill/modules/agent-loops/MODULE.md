# agent-loops

## Sets up

- `.agents/skills/ship/SKILL.md`: five gates from a finished branch to the default branch: local review, pull request from the template, `babysit`, the required CI checks (`All checks pass` when the `ci` module is selected), then `gh pr merge --squash --match-head-commit <sha>`. Watches for merge conflicts, which stop GitHub from starting any `pull_request` workflow.
- `.agents/skills/babysit/SKILL.md`: the AI review loop: read the newest review, a fix-or-rebut ledger per finding, rebuttals that name the guard at `path:line`, the rebuttal posted before the push, `/ai-review` when there is nothing to push, and a stop when the same finding returns twice.
- `.github/pull_request_template.md`: Linked issue, What changed, Verification, Failure modes (only when tests change), Risk and security impact, Screenshots, Approvability (lint and type escapes).
- Requires `agent-docs` (the skills folder and `AGENTS.md` they point at) and `ai-review` (the review comment, the `/ai-review` rebuttal trigger, and the `AI review` status).

## Tailor

1. **Merge an existing PR template.** When `.github/pull_request_template.md.repo-kit-new` exists, or the repo has `.github/PULL_REQUEST_TEMPLATE.md` or a `.github/PULL_REQUEST_TEMPLATE/` folder, keep one template: carry the project's own sections (type-of-change boxes, CLA, deploy notes) into the kit's structure. Delete the other file; GitHub reads only one. Done when `ls .github | grep -i pull_request` prints one name and no `*.repo-kit-new` from this module remains.
2. **Match the required check name.** Read the branch protection or ruleset of the default branch (`gh api repos/{owner}/{repo}/rules/branches/<default>` or `gh api repos/{owner}/{repo}/branches/<default>/protection`). When the required check is not `All checks pass`, replace that name in `ship/SKILL.md`. Done when every check name in `ship/SKILL.md` is a check the default branch requires or the repo's workflows produce.
3. **Match the review comment.** `babysit` reads what `.github/ai-review/publish.ts` renders: a `github-actions` comment starting `## AI review`, with `### Findings`, `### Withdrawn findings`, numbered finding lines such as `1. **[NEW][P1] Title** - path:line`, and a ``<sub>Commit `` footer. When the project changed `publish.ts`, update step 1 of `babysit/SKILL.md` to match. Done when the `jq` filter in step 1, run against a pull request with a finished review, prints that review.
4. **Fit the repo's merge rules.** When the repo allows only merge commits or only rebase merges (`gh api repos/{owner}/{repo} --jq '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}'`), change `--squash` in gate 5 to the allowed method. Done when the flag in gate 5 is allowed by the repo.
5. **Adopt.** After any edit, run `node <kit>/scripts/kit.ts adopt <edited paths>` so later kit runs propose changes beside the file instead of replacing it. Done when `kit.ts check` lists none of this module's files as `edited`.

## Owner steps

- Allow squash merges and delete branches after merge (`ship` relies on both):

  ```sh
  gh repo edit --enable-squash-merge --delete-branch-on-merge
  ```

- Branch protection, so `ship` cannot merge red code: one owner step sets it for the whole kit, in the `ci` module's `MODULE.md` ("Owner steps"). Without the `ci` module, require the repository's own checks and `AI review` on the default branch through its existing protection or ruleset.

## Verify

- `head -4 .agents/skills/ship/SKILL.md` and `head -4 .agents/skills/babysit/SKILL.md` show front matter with `name:` and a `description:` that starts with the action.
- `ls .claude/skills/` lists `ship` and `babysit` (through the `agent-docs` symlink).
- `grep -n -- "--admin\|--no-verify\|--force" .agents/skills/ship/SKILL.md` prints only lines that forbid them.
- `grep -c "^## " .github/pull_request_template.md` prints `7`.
- On a test pull request, ask the agent to "babysit this PR": its first output is a ledger table with one row per finding of the newest review.

## Prior art

- Five gates, merge with `--squash --match-head-commit`, no `--admin`, and the merge-conflict watch (GitHub starts no `pull_request` workflow while a PR conflicts): openbot `.agents/skills/ship/SKILL.md`, sections "Gate 5" and "While you wait".
- Fix-or-rebut table, the validity tests, one rebuttal line per finding with `path:line`, rebuttal posted before the push, an explicit re-review phrase only when there is nothing to push, stop when a finding returns twice: openbot `.agents/skills/babysit/SKILL.md`, steps 2 to 6. The kit reads the review by its visible headings (`## AI review`, `### Findings`) rather than the hidden `<!-- ai-review -->` marker, so a reader can check the filter by eye.
- PR template sections, "Failure modes" written before the code, and "Approvability" for lint and type escapes: openbot `.github/PULL_REQUEST_TEMPLATE.md`. The kit drops openbot's type-of-change boxes and CLA text, which are project-specific.
- Skill front matter with the trigger words first: `writing-for-agents` (mattpocock-skills), "Context pointers".
