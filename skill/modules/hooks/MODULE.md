# hooks

## Sets up

- `.githooks/pre-commit` (POSIX sh), the fast local gate; CI runs the full suite on every pull request:
  - runs `check:staged` (Biome formats and lints the staged files and fixes what it can);
  - stages the fixes again for files that were fully staged. When the fixer changed a file that also has unstaged edits, it stops the commit and names the file, because staging it would also commit the edits you left out;
  - runs `typecheck` when a staged change touches a `.ts`/`.tsx`/`.mts`/`.cts` file, a `tsconfig*.json` or a `package.json` (deletions count);
  - runs `knip` when a `package.json` or the lockfile is staged;
  - with `supply-chain`, runs `gitleaks git --staged` when the `gitleaks` binary is installed.
- `.githooks/pre-push` (with `tests`): runs `test:changed` against `origin/<default-branch>`, and lets the push through with a message when that branch does not exist yet.
- Script `prepare`: `git config core.hooksPath .githooks` inside a git checkout, nothing outside one (a Docker build, a published tarball). The package manager runs it on every install, so each clone gets the hooks.
- Requires `quality` for `check:staged`, `typecheck` and `knip`.

## Tailor

1. **Retire the old hook manager.** If the project uses husky, lefthook or simple-git-hooks, move any check they run that this hook lacks into `.githooks/pre-commit` (keep it POSIX sh), then remove the tool, its config, and its `prepare` or `postinstall` script. Done when `git config core.hooksPath` prints `.githooks` and `package.json` mentions none of those tools.
2. **Merge the `prepare` script.** When the project already had a `prepare` script (reported as `script-conflict`), join the two with `&&`, the hooks command last. Done when `<pm> run prepare` exits 0 and `git config core.hooksPath` prints `.githooks`.
3. **Keep the hook fast.** Time a typical commit with `time git commit`. If `typecheck` is the slow part in a monorepo, call a script that typechecks only the projects that contain staged files. Done when a one-file commit finishes in under about 10 seconds, or `AGENTS.md` says why it cannot.
4. **Say how to skip it.** In `AGENTS.md`, note that `git commit --no-verify` skips the hook for work-in-progress commits and that CI still runs everything. Done when `grep -n "no-verify" AGENTS.md` finds the line.

## Owner steps

None.

## Verify

- `<pm> install`, then `git config core.hooksPath`: prints `.githooks`.
- Stage a `.ts` file with a formatting slip and commit: the commit succeeds and `git show HEAD` has the formatted version.
- Stage half of a file's edits (`git add -p`) where Biome will reformat it and commit: the hook stops and names the file; `git diff --cached` still holds only what you staged.
- Commit a change to a `.md` file only: no "typechecking" line in the output.
- `sh -n .githooks/pre-commit && sh -n .githooks/pre-push`: no output.

## Prior art

- Re-staging only fully staged files and stopping when the fixer touched a partly staged one, compared by `git hash-object` before and after: openbot `.githooks/pre-commit`. Ours is written from scratch on the same idea.
- Format, then lint, on the staged files before the slower checks, so lint reads the formatted file: t3code `vite.config.ts` (`staged`, in that order); ai `.husky/pre-commit` hands the staged files to lint-staged. Biome's `check --write` does both in one pass.
- Typecheck only when code or config changed: openbot `.githooks/pre-commit` (its `code_pattern`), which then typechecks only the affected projects with `scripts/staged-typecheck.ts`. We run the project's whole `typecheck` because a default repo has one project; Tailor step 3 covers monorepos. knip on a manifest change: t3code runs `knip:check` for any code or manifest change; we narrow it to `package.json` and the lockfile to keep commits fast, since CI runs knip on every pull request.
- Slower checks on push rather than on commit: opencode `.husky/pre-push` runs `bun run check` before every push. Ours runs only the tests for changed files and leaves the full suite to CI.
- `core.hooksPath` set from `prepare` instead of a hook-manager dependency: openbot keeps plain `.githooks`; dropping husky removes one install-time package.
