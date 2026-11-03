# changelog

## Sets up

- `changelog.d/README.md`: the fragment format: one file per pull request named after the branch, Keep a Changelog groups (Added, Changed, Deprecated, Removed, Fixed, Security), bullets written for users.
- `scripts/changelog.mts`, stdlib only:
  - `check` validates every fragment (allowed `###` groups, no empty bullets, no bullet outside a group). With `--base <rev>`, it also fails when the diff from the merge base of `<rev>` and `HEAD` adds no fragment and no `CHANGELOG.md` change, unless `--labels` includes `no-changelog`.
  - `release <version>` folds every fragment into `CHANGELOG.md` under `## [<version>] - YYYY-MM-DD`, groups in Keep a Changelog order, bullets in file-name order, and deletes the folded files. It refuses with no fragments, an invalid fragment, or a version already in `CHANGELOG.md`, and then changes nothing.
- `.github/workflows/changelog.yml`: on `pull_request` (`opened`, `synchronize`, `reopened`, `labeled`, `unlabeled`), runs `node scripts/changelog.mts check --base HEAD^1` with the PR's labels; `contents: read` only, no install step.
- Scripts `changelog:check` and `changelog:release`.

## Tailor

1. **Pick changesets instead when the project publishes packages.** Do this step first, before any other module's Tailor step edits `AGENTS.md` or the skills. When `.changeset/` exists, run `node <kit>/scripts/kit.ts remove changelog` and stop: changesets already owns versioning and notes. The remove deletes this module's untouched files, and the engine renders the untouched `AGENTS.md`, `ship` skill and `dependabot.yml` again without their release-notes text. When the project is a published library (`library` in `kit.ts detect`) with no changesets yet, tell the developer that changesets fits a library better (it bumps versions per package and writes the notes into each package's changelog), and keep this module only if they choose it. Done when the project has exactly one release-notes system and `grep -rn "changelog.d\|no-changelog" AGENTS.md .agents .github` prints nothing after a remove.
2. **Keep the history.** When `CHANGELOG.md` exists, leave its released sections as they are. Move the bullets under an `## [Unreleased]` heading into `changelog.d/unreleased.md`, grouped by the six headings, and leave that heading empty; `release` writes each new version below it. When it uses other group names (`Features`, `Bug Fixes`), map them to the six groups in the fragment. Done when `<pm> run changelog:check` passes.
3. **Hook into the release.** Find the project's release path (a `release` script, a release workflow, `npm version` hooks) and call `<pm> run changelog:release <version>` before the version commit, so the notes ship in the same commit as the version bump. Done when the release path runs `changelog:release`, or the developer confirms releases are manual and `AGENTS.md` says how to cut one.
4. **Required check.** When the default branch has a ruleset or protection with required checks, decide with the developer whether `Release notes` joins them. Done when the answer is recorded in the PR body.

## Owner steps

- Create the opt-out label:

  ```sh
  gh label create no-changelog --description "No user-visible change: skip the release notes check" --color ededed --force
  ```

  Run it before the first pull request after this module lands. With `supply-chain` selected, Dependabot puts this label on its pull requests, and it skips labels the repository does not have.

## Verify

- `<pm> run changelog:check` exits 0 and prints `Release notes are fine.`
- Write `changelog.d/verify.md` with `### Misc` and one bullet: `changelog:check` exits 1 and names `"### Misc" is not a group`. Delete the file.
- On a branch with a code change and no fragment: `node scripts/changelog.mts check --base origin/<default>` exits 1 and names `changelog.d/<branch>.md`; with `--labels no-changelog` it exits 0.
- `actionlint .github/workflows/changelog.yml` prints nothing.
- On a pull request: the `Release notes` check fails with no fragment, and passes again after `gh pr edit <pr> --add-label no-changelog`, with no new push.

## Prior art

- One fragment per pull request in `changelog.d/<branch>.md`, the `no-changelog` label, the label events re-running the check, `fetch-depth: 2` with `HEAD^1` as the base: openbot `changelog.d/README.md` and `.github/workflows/changelog.yml`. Openbot's check is a `grep` pipeline in the workflow plus `scripts/check-release-notes.ts`; the kit moves both into one script so the rule runs the same locally and in CI.
- Fragment validation (allowed groups, non-empty items) and folding into `CHANGELOG.md` at release time: openbot `scripts/check-release-notes.ts --fragments` and its `release:*` scripts.
- Keep a Changelog groups and the `## [version] - date` heading: keepachangelog.com 1.1.0.
- Changesets for published libraries: vercel/ai `.changeset/` and `.github/workflows/verify-changesets.yml`.
