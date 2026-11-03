---
name: babysit
description: Babysit a pull request through the AI review loop. Triage each finding, fix the valid ones, rebut false positives with the guard at path:line, and re-run the review until it is clean. Use when asked to babysit a PR, answer AI review findings, or clear the AI review gate.
---

# Babysit

Drive one pull request through repeated AI reviews until no valid finding remains. Each round is one **ledger** update: every finding gets a verdict, fix or rebut, with evidence.

This skill covers the AI review on the current pull request. Human reviews get a direct answer in their own thread.

## Before you start

1. Read `AGENTS.md` and the nested `AGENTS.md` of each directory the pull request changes.
2. Find the pull request number and head SHA: `gh pr view --json number,headRefOid,url`.
3. Run `git status`. Commit or stash unrelated work.
4. Check that your `gh` user can trigger the review: `gh api repos/{owner}/{repo}/collaborators/$(gh api user --jq .login)/permission --jq .permission` prints `admin`, `maintain`, or `write`. With any other answer, you write the rebuttals and the developer posts them.

Done when you know the pull request, its head SHA, and who can post rebuttals.

## Step 1: read the newest review

1. Load only the newest AI review comment: the newest comment from `github-actions` whose body contains `## Findings`.

   ```sh
   gh pr view <pr> --json comments --jq '[.comments[] | select((.author.login | startswith("github-actions")) and (.body | contains("## Findings")))] | last | {url, createdAt, body}'
   ```

2. Check that it is fresh: it names the head SHA (short or full), or it was posted after the last push. Read the `AI review` status on the head SHA:

   ```sh
   gh api repos/{owner}/{repo}/commits/<head-sha>/status --jq '.statuses[] | select(.context == "AI review") | .state'
   ```

   `pending`, or a comment older than the last push, means the review still runs: wait (step 5, item 4) and read again.
3. Read `## Findings` and, when present, `## Withdrawn Findings` together. A finding line starts with `**[NEW]` or `**[REMAINS]`; note its title, priority, and `path:line`.

Done when you hold every finding of a fresh review. Leave the review comment as the bot wrote it.

## Step 2: triage each finding

Check each finding against the current diff and the code around it. Reproduce the failure it claims, by reading or running the code; the title alone proves nothing.

A finding is **valid** when it:

- points at changed code or a direct effect of changed code,
- names a concrete failure: wrong result, crash, data loss, security hole, broken contract, measurable regression, dead or duplicated code, and
- has a small fix inside the scope of this pull request.

A finding is **not valid** when:

- the guard, check, or contract it asks for already exists: you name its `path:line`,
- it is a style or naming opinion with no failure,
- its edge case has no path that reaches it,
- it asks for a test that no concrete regression would turn red, or
- it asks for work outside the problem this pull request solves.

Write the ledger before you change code:

| Finding | Priority | Verdict | Evidence |
| --- | --- | --- | --- |
| Short title, `path:line` | P0 to P3 | fix / rebut | the line, guard, or contract |

Done when every finding has a verdict and evidence. Fix only what you proved; a finding you cannot reproduce gets a rebuttal, never a speculative change to turn the gate green.

## Step 3: fix each valid finding

1. Make the smallest change that removes the failure. Prefer deleting and reusing over adding.
2. Keep the non-negotiable rules in `AGENTS.md`.
3. Run the focused checks from `AGENTS.md` "Checks" for the changed files.
4. Commit on the pull request branch. Do not push yet.

Tests keep their strength, types keep their precision, and the review workflow and its prompt stay as they are: a fix changes the code under review, never the reviewer. Done when each `fix` row has a commit.

## Step 4: write the rebuttal

The reviewer withdraws a finding only for a concrete, checkable reason. One comment holds all rebuttals for the round, one line per finding:

```
P1 Short title: wrong, <guard or contract> at `path:line`.
```

Give the reason and the line that proves it. Each word lands in the next review prompt, so leave out greetings, summaries of fixes, SHAs, and restated findings: the reviewer reads the fixes in the diff.

Only a comment from a user with write access counts. When yours does not, hand the developer the exact comment text and wait for them to post it.

Done when every `rebut` row has a line that names a `path:line`.

## Step 5: post, push, and wait for one new review

One round is one new review. Ask for exactly one:

1. **Fixes to push:** post the rebuttal comment first, without `/ai-review`: `gh pr comment <pr> --body-file <file>`. Then `git push`. The push re-runs the review, and the review reads every comment posted since the last one.
2. **Nothing to push:** start the rebuttal comment with `/ai-review` and post it. That comment re-runs the review.
3. **Nothing to rebut and fixes to push:** push. The push re-runs the review.
4. Wait for a new review comment and an `AI review` status on the new head SHA that is no longer `pending`. Poll at most once every 2 minutes; a review takes minutes, not seconds. Between polls, check `gh pr view <pr> --json mergeable` as the `ship` skill says: a conflicting pull request starts no workflow.

Done when a fresh review exists for the current head SHA.

## Step 6: loop until clean

Go back to step 1 with the ledger from the last round:

- A finding gone from `## Findings` needs no more work.
- A withdrawn finding stays closed. When new code brings the same problem back for a new reason, treat it as new.
- A `[REMAINS]` finding needs a fix or a stronger rebuttal. Name the part of your last rebuttal the reviewer could not verify, and give better evidence.

Stop, clean, when both hold:

- `## Findings` lists nothing, or only findings the reviewer has withdrawn.
- The `AI review` status on the head SHA is `success`, when the repository posts one.

Stop and hand back to the developer when the same finding returns twice with no progress, when a valid finding needs a product decision, or when the review fails or posts output you cannot parse.

## Report

After each round:

| Finding | Verdict | Action |
| --- | --- | --- |
| Short title, `path:line` | fix / rebut | commit SHA or rebuttal line |

Then the head SHA, the round count, the `AI review` status, and the checks you ran, one line each.
