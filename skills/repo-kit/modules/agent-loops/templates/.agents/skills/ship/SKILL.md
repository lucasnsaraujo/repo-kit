---
name: ship
description: Ship the current branch to {%defaultBranch%}. Review the diff locally, open the pull request, babysit the AI review when the change is high risk and CI until green, then squash-merge. Use when a change is finished and the developer asks to ship it, merge it, or get it to {%defaultBranch%}.
---

# Ship

Take one finished branch to `{%defaultBranch%}` through five gates, in order: local review, pull request, AI review, CI, merge. Each gate ends on a state you can read from `git` or `gh`; move on only when that state holds.

Invoking this skill approves the merge at the end, and only when every gate is green on the same head SHA.

## Before you start

1. Read `AGENTS.md` and the nested `AGENTS.md` of each directory in the diff.
2. Run `git branch --show-current`. On `{%defaultBranch%}`, create a branch named after the outcome first.
3. Run `git fetch origin {%defaultBranch%}`, then `git diff --stat origin/{%defaultBranch%}...HEAD` and `git status --short` to see the change set.
4. When `gh pr view --json number,state,url` finds a pull request for the branch, resume at the first gate that is not done.

Done when you are on a feature branch and know the change set.

## Gate 1: review the diff locally

A local review costs less than an AI review round.

1. Commit the finished work, one logical change per commit. Leave unrelated changes out.
2. Review `origin/{%defaultBranch%}...HEAD` for correctness, data loss, the non-negotiable rules in `AGENTS.md`, and code that duplicates an existing helper. Use a code review skill or a review subagent when one is available, and give it the diff range, not your conclusions.
3. Triage each finding as `babysit` step 2 says. Fix the findings you can prove; record the rest with the reason they do not hold.
4. Run the focused checks from `AGENTS.md` "Checks" for the changed files.
{%if module:changelog%}
5. When a user can see the change, add `changelog.d/<branch>.md` as `changelog.d/README.md` says. Otherwise plan to add the `no-changelog` label in gate 2.
6. Commit the fixes. When a commit hook fails, fix the cause and commit again.
{%else%}
5. Commit the fixes. When a commit hook fails, fix the cause and commit again.
{%endif%}

Done when every finding is fixed or recorded as not valid, and the focused checks pass.

## Gate 2: open the pull request

1. Push: `git push -u origin HEAD`.
2. Write the body from `.github/pull_request_template.md` into a file. Fill every section it keeps; remove the sections it says to remove.
3. Create it: `gh pr create --base {%defaultBranch%} --title "<outcome, imperative>" --body-file <file>`.
{%if module:changelog%}
4. With no release notes, add the label: `gh pr edit <pr> --add-label no-changelog`.
{%endif%}

Done when `gh pr view --json url` prints the pull request URL.

## While you wait

Gates 3 to 5 wait on GitHub. `{%defaultBranch%}` can move during the wait. GitHub starts no `pull_request` workflow on a pull request with a merge conflict, so a wait for checks on a conflicting pull request never ends.

1. Before each wait and at each poll, run `gh pr view <pr> --json mergeable,mergeStateStatus,headRefOid`. Poll at most once every 2 minutes.
2. `UNKNOWN`: GitHub is still computing. Ask again at the next poll.
3. `CONFLICTING` or `DIRTY`: stop waiting and resolve the conflict (gate 4, step 5).
4. No check run or status on the head SHA 10 minutes after a push: check `mergeable` first, then `gh run list --branch <branch> --limit 5`. Act on what they show.

## Gate 3: babysit the AI review

The review workflow rates each push by the files the pull request changes (`.github/ai-review/risk.json`: auth, payments, migrations, secrets, CI, dependencies) and by any P0 or P1 the last review left open. Read the rating on the current head SHA once the `AI review` status appears:

```sh
gh api "repos/{owner}/{repo}/commits/<head-sha>/status" --jq '.statuses[] | select(.context == "AI review") | "\(.state) \(.description)"'
```

- `success low risk: review not required`: the pull request is **low risk**. No review runs; gate 3 is done.
- Anything else: the pull request is **high risk**. Run the `babysit` skill on it. It owns triage, fixes, rebuttals, and re-review requests. Apply "While you wait" during each of its waits.

Each push is rated again: a fix that touches a risky file turns a low-risk pull request high risk.

Done when the `AI review` status on the current head SHA is `success`, and for a high-risk pull request `babysit` reports a clean review on that SHA.

## Gate 4: make CI green

{%if module:ci%}
The required check is `All checks pass`, which waits for every other job.
{%else%}
The required checks are the ones `gh pr checks <pr> --required` lists.
{%endif%}

1. Watch the head SHA: `gh pr checks <pr> --watch --interval 120`, in the background, checking `mergeable` at each wake.
2. For each failed job, read only its failed log: `gh run view <run-id> --log-failed`. Find the cause.
3. A failure caused by the change: fix it, commit, push. Each push starts a new AI review: return to gate 3.
4. A failure unrelated to the change (network timeout, runner crash): `gh run rerun <run-id> --failed`, once. When the same job fails again, stop and report it.
5. A merge conflict: merge `origin/{%defaultBranch%}` into the branch, resolve the conflicts, run the focused checks, and push. The history stays as it is: a plain push, never a rebase or force-push. Return to gate 3.
6. Answer each open human review thread. A thread someone else opened stays open until they resolve it.

A test changes only when the behaviour it guards changes on purpose. Done when every required check is `success` on the head SHA.

## Gate 5: merge

Merge only when all of these hold on the same head SHA:

- `gh pr view <pr> --json mergeStateStatus,headRefOid` shows `CLEAN`.
- Every required check is `success`, and so is `AI review`.
- No valid AI review finding is open, and no human thread waits for an answer.

Then merge by the rating from gate 3, read again on this head SHA:

- **Low risk**: let GitHub merge as soon as its own requirements hold, so a late check or a queue does not need you to wait:

  ```sh
  gh pr merge <pr> --squash --auto --match-head-commit <head-sha>
  ```

- **High risk**: merge now, after the clean review:

  ```sh
  gh pr merge <pr> --squash --match-head-commit <head-sha>
  ```

`--match-head-commit` refuses the merge when a push landed after your last check. Branch protection applies to you as to anyone: `--admin` and `--no-verify` are off limits.

With `--auto`, poll `gh pr view <pr> --json state,autoMergeRequest` every 2 minutes until the state changes; when GitHub turns auto-merge off (a new push, a failed check), go back to the gate that failed.

Done when `gh pr view <pr> --json state,mergeCommit` shows `MERGED`, and after `git fetch origin {%defaultBranch%}`, `git branch -r --contains <merge-sha>` lists `origin/{%defaultBranch%}`.

## Stop and ask

Hand back to the developer when:

- A fix needs a force-push, a history rewrite, or a change outside this repository.
- A valid finding, or a merge conflict, needs a product decision.
- `babysit` stops with no progress.
- CI fails twice for a cause you cannot fix inside the change.
- The merge needs `--admin` or a branch protection change.

## Report

| Gate | Result | Evidence |
| --- | --- | --- |
| Local review | N fixed, M not valid | commit SHAs |
| Pull request | opened | URL |
| AI review | low risk, not reviewed / clean after N rounds | status or review comment link |
| CI | required checks success | run link |
| Merge | merged | merge commit SHA |

Then one line per check you ran locally, and one line for what you left to CI.
