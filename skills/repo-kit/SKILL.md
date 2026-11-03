---
name: repo-kit
description: Set up or update a TypeScript repo's dev workflow from selectable modules - CI, AI review, tests, hooks, env, supply chain, changelog, agent docs and loops.
disable-model-invocation: true
---

# repo-kit

Configure the project in the current directory with our standard workflow. The engine (`scripts/kit.ts`) does the mechanical part: it renders templates, merges `package.json` and `.gitignore`, never overwrites a file someone edited, and records the selection in `.repo-kit.json`. You do the judgment part: pick modules with the owner, merge conflicts, tailor each module to the real repo, and verify.

`KIT` below means `node <this skill's folder>/scripts/kit.ts` (Node 22.18+, or `bun` instead of `node`). Every command takes `--root <project>`; the default is the current directory.

## 1. Detect

Run `KIT detect` and `KIT modules`. Read the stack: package manager, monorepo, existing lint/test/hook tools, workflows, and `lock` (a previous selection). The kit supports bun and pnpm; on npm or yarn, stop and tell the owner.

Check the working tree with `git status --short`. Work on a branch named `chore/repo-kit-setup` (or `chore/repo-kit-update`), never on the default branch.

Done when you can name, for each module, whether the repo already has an equivalent.

## 2. Choose modules

When `lock` exists, this is an update: keep the recorded modules and ask only about new ones.

Otherwise show the owner every module with one line each and a default, then ask once: all, or which. Defaults:

- All modules are recommended. Mark a module as "replace" when the repo already has an equivalent (ESLint or Prettier → `quality` replaces them with Biome; Husky or Lefthook → `hooks`; Jest → `tests`; Renovate → `supply-chain` keeps Renovate and skips Dependabot; `.changeset/` → skip `changelog`).
- `agent-loops` pulls in `agent-docs` and `ai-review`; `hooks` pulls in `quality`.

Done when the owner has answered, or has said to use the defaults.

## 3. Plan

Run `KIT plan --modules <ids|all>`. Show the owner a short summary: files created, files updated, conflicts (`conflict`, `script-conflict`, `symlink-conflict`), lines and scripts added, and the install command.

Done when every conflict in the plan has a planned resolution: merge, keep theirs, or take ours.

## 4. Apply

Run `KIT apply --modules <ids|all>`, then run the printed `installCommand`. The project's release-age policy picks the versions.

Done when apply exits 0 and the install succeeds.

## 5. Tailor

For each selected module, in the order apply printed, read `modules/<id>/MODULE.md` and work its `## Tailor` steps. Each step ends on its own completion criterion. The work the engine leaves to you:

- **Conflicts.** For each `<path>.repo-kit-new`, merge our version into theirs by hand, keeping the project's intent. Then delete the `.repo-kit-new` file and run `KIT adopt <path>`, so later updates propose changes instead of overwriting.
- **Script conflicts.** Decide per script: keep the project's command, or replace it with ours. Record the choice in the final report.
- **Placeholders.** Replace every `<!-- fill: ... -->` with facts read from the repo (scripts, folders, real risks). `grep -rn "<!-- fill:" .` returns nothing when you are done.
- **Repo-specific rules.** Write the review rule fragments, CI lanes, env loader and smoke checks that MODULE.md asks for, from what this repo actually does.

Edit a kit-written file only when the Tailor step says to, and then `KIT adopt` it.

Done when every Tailor step of every selected module meets its criterion, no `*.repo-kit-new` file is left, and `KIT check` prints `[]`.

## 6. Verify

Run every command in each selected module's `## Verify` section. Also run `actionlint` on `.github/workflows/`, and the project's `lint`, `typecheck` and `test` scripts.

Done when every check passes. A check that cannot run locally (it needs GitHub, a secret, or a real PR) goes in the report as unverified, with the reason.

## 7. Owner steps and report

Collect every `## Owner steps` entry from the selected modules: secrets (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, `DOTENV_PRIVATE_KEY_PRODUCTION`), variables (`AI_REVIEW_GATE`), labels, and branch protection (required checks `All checks pass` and `AI review`). These change the GitHub repository, so list them numbered with their exact commands and run them only after the owner approves the batch.

Commit on the branch in logical steps: one commit for the engine output, then one per tailored module. The final report covers:

- modules applied, and modules skipped with the reason;
- conflicts and how each was resolved;
- checks run and their results;
- what is unverified;
- the owner steps still open.

## Updating a project later

Run steps 1, 3, 4, 5 and 6 with the recorded modules (`KIT apply --modules <any new ids>` keeps the old ones). Untouched files update in place. Edited and adopted files get a `.repo-kit-new` proposal to merge. `KIT check` reports drift between updates. `KIT remove <module>` deletes that module's untouched files and package scripts, keeps edited ones, and re-renders the other modules' untouched files so they stop mentioning it.

## Reference

- `reference/module-format.md`: module.json fields, template syntax, and how to add a module.
- `modules/<id>/MODULE.md`: what each module sets up, its Tailor, Owner steps, Verify, and the prior art it follows.
