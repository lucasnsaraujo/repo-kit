# ci

## Sets up

- `.github/workflows/ci.yml`: runs on pull requests, pushes to the default branch and manual dispatch, with `contents: read` only. A new push to a pull request cancels its older run.
- Job `changes` ("Pick lanes"): reads the pull request's changed files from the merge commit (`git diff HEAD^1 HEAD`) and sets one output per lane: `check` and `test`. It fails open: a push or dispatch, an unlistable diff, a shared file (`package.json`, lockfiles, `tsconfig*.json`, `biome.json`, `knip.json`, `.nvmrc`, `.github/`) or a path no lane claims turns every lane on. A change to `.md`/`.mdx` files only skips both lanes.
- Job `check` ("Lint and types"): with the `quality` module, `lint`, `typecheck`, `knip`, `types:ratchet` and `check:lint-rules`; without it, whichever of the project's `lint` and `typecheck` scripts exist.
- Job `test` ("Tests"): `test` (the `tests` module's `vitest run`, or the project's own test script when it has one).
- Job `docs` ("Docs", with `agent-docs`): `check:docs`, on every change and with no lane, because the docs check also follows links to code files.
- Job `secrets` ("Secret scan", with `supply-chain`): downloads gitleaks 8.30.1, verifies its sha256, and scans the pull request's commits (`--log-opts=BASE..HEAD`) or, on a push, the full history. It has no lane: it runs on every change.
- Job `ci-ok` ("All checks pass"): the one check branch protection requires. It runs `if: always()` and fails unless every needed job succeeded; a job may be skipped only when its lane output from `changes` is `false`.
- `.github/actions/setup/action.yml`: Node from `.nvmrc` or `.node-version` (else the version detected at apply time), the package manager (pnpm reads `packageManager`; Bun reads `packageManager` or `engines.bun`), and `install: frozen` (the default, a frozen-lockfile install) or `install: none`. Any other input value fails the step.
- Every action is pinned to a commit SHA with its version in a comment; every job has `timeout-minutes`.

## Tailor

1. **Merge an existing workflow.** When `.github/workflows/ci.yml.repo-kit-new` exists, or other files in `.github/workflows/` run lint, typecheck or tests, move each project-specific step (services, build, extra env, matrix) into the matching job of the new file and delete the duplicate workflow. Done when `ls .github/workflows` shows no second workflow that runs the same checks and no `*.repo-kit-new` from this module remains.
2. **Fit the lanes to the repository.** Edit only the block between `# ---- lanes: edit these patterns for this repository ----` and `# ---- end lanes ----` in the `changes` job: add generated or vendored folders that affect everything to `SHARED`, add files that need no check to `INERT`, and for a monorepo give each package its own lane (for example `[web]='^apps/web/'`) with a matching job. Every lane needs three things with the same name: a `LANES` entry, an `outputs:` line on `changes`, and a job whose `if:` reads that output and that `ci-ok` lists under `needs`. Done when each job in `ci.yml` except `changes`, `docs`, `secrets` and `ci-ok` has a lane of its own name, and `actionlint` passes.
3. **Check the toolchain inputs.** For pnpm, `package.json` must have `"packageManager": "pnpm@<version>"` (pnpm/action-setup fails without it). For Bun, add `"packageManager": "bun@<version>"` so CI does not float to the latest Bun. The `quality` scripts run as `node <file>.mts`, which needs Node 22.18 or newer in `.nvmrc`. Done when `jq -r .packageManager package.json` prints a pinned version and `cat .nvmrc` (if present) is 22.18 or newer.
4. **Add the project's real build and service needs.** If tests need a database, a build step, or secrets, add them to the `test` job (services, `env:` from `secrets.*`). Done when the first CI run on a pull request passes, or fails only on real findings.

## Owner steps

1. **Protect the default branch with the kit's required checks.** This is the one branch-protection step for the whole kit; other modules point here. Run it after the first pull request has reported each check, so GitHub knows the names. It reads the selected modules from `.repo-kit.json`:
   - always: `All checks pass` (this module's `ci-ok` job);
   - with `ai-review`: `AI review` (the commit status `publish.ts` sets); `opencodereview` sets no status, so it adds nothing here;
   - with `changelog`: `Release notes` (the `notes` job in `changelog.yml`);
   - with `agent-loops`: admins follow the rules too (`ship` never merges with `--admin`) and review conversations must be resolved.

   ```sh
   modules=$(jq -c .modules .repo-kit.json)
   jq -n --argjson modules "$modules" '
     ($modules | index("ai-review") != null) as $ai
     | ($modules | index("changelog") != null) as $changelog
     | ($modules | index("agent-loops") != null) as $loops
     | {
         required_status_checks: {
           strict: false,
           checks: ([{context: "All checks pass"}]
             + (if $ai then [{context: "AI review"}] else [] end)
             + (if $changelog then [{context: "Release notes"}] else [] end))
         },
         enforce_admins: $loops,
         required_pull_request_reviews: null,
         restrictions: null,
         required_conversation_resolution: $loops
       }' |
     gh api -X PUT "repos/{owner}/{repo}/branches/<default-branch>/protection" -H "Accept: application/vnd.github+json" --input -
   ```

   The PUT replaces the branch's whole protection setting. When the branch already has protection, read it first with `gh api repos/{owner}/{repo}/branches/<default-branch>/protection` and carry the fields the owner wants to keep into the request. With `ai-review`, a pull request from a fork gets no automatic review, so a maintainer comments `/ai-review` on it before it can merge.

## Verify

- `actionlint .github/workflows/ci.yml`: no output, exit 0.
- Open a pull request that changes only a `.md` file: "Lint and types" and "Tests" show as skipped and "All checks pass" is green.
- Open a pull request that changes a `.ts` file: "Lint and types" and "Tests" run, and "All checks pass" goes green only after both pass.
- `gh api repos/{owner}/{repo}/branches/<default-branch>/protection --jq '.required_status_checks.checks[].context'` prints `All checks pass`, plus `AI review` and `Release notes` when those modules are selected.

## Prior art

- Lanes from a `changes` job that fails open, push and dispatch running everything: t3code `.github/scripts/ci-changes.cjs` (unknown paths run every job) and openbot `ci.yml` `detect` job. Departs from both by keeping the patterns inline in one marked block instead of a script, so a single-package repo has one file to read; a monorepo can still grow it.
- One required aggregator that accepts a skip only when the lane said so: t3code `.github/workflows/ci.yml` (~line 589, the `jq` gate keyed by job name). Chosen over openbot's `success|skipped` rule, which lets a job skipped by a broken `if:` pass.
- Composite setup action shared by every job: t3code and openbot both install the toolchain once per job through one action; ours adds the validated `install` input so a typo cannot silently skip the install.
- gitleaks from a checksum-verified release binary rather than a third-party action, so the only code CI runs is pinned by hash; opencode keeps a `.gitleaksignore` for its scan. The version and hash are the `supply-chain` module's contract.
