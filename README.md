# repo-kit

[![CI](https://github.com/lucasnsaraujo/repo-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/lucasnsaraujo/repo-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code skill that sets up a TypeScript repo with a complete dev workflow: CI that only runs what changed, a Claude Code reviewer on every pull request, hermetic tests, fast git hooks, encrypted env files, supply-chain guards, release notes, and agent docs that stay honest.

You pick the modules. The skill detects what the repo already has, shows a plan, applies it without overwriting anything you edited, tailors each module to your code, and verifies the result.

```
> /repo-kit:repo-kit

Detected: pnpm, single package, ESLint + Prettier, Jest, 2 workflows.
Modules: all recommended. quality replaces ESLint/Prettier, tests replaces Jest.
Plan: 47 files to create, 1 conflict (.github/workflows/ci.yml), 15 scripts, 4 dev dependencies.
```

## Modules

| Module | What it sets up |
|---|---|
| `ci` | GitHub Actions with lanes picked from the diff, one required `All checks pass` job that allows a skip only when that lane had nothing to check, and `ci:local` to run the same checks in order before a push |
| `ai-review` | Claude Code reviews each PR that touches a risky area (auth, payments, migrations, secrets, CI, dependencies) with your Claude subscription, posts P0–P3 findings that carry over between pushes, takes rebuttals via `/ai-review`, and gates merge on P0/P1 once you turn the gate on; other PRs pass as low risk |
| `opencodereview` | Instead of `ai-review`, for owners with a server: [OpenCodeReview](https://github.com/BridgLabs/opencodereview) runs there in Docker and reviews each PR with evidence-checked findings; the kit writes the `REVIEW.md` it reads and lists the server setup |
| `quality` | Biome with anti-slop test rules (each proven by fixtures), knip for dead code, and a strict-TypeScript ratchet that only lets error counts go down |
| `tests` | Vitest with secrets scrubbed from the environment and a temp `HOME`, changed-file runs, and an end-to-end smoke script that writes a JSON report |
| `hooks` | pre-commit formats and lints staged files, typechecks, runs knip on manifest changes; pre-push runs the changed tests |
| `env` | dotenvx: encrypted `.env.dev` and `.env.production` committed, keys in one ignored `.env.keys`, a typed loader at the app boundary |
| `supply-chain` | 3-day minimum release age, exact versions, an install-script allowlist, grouped Dependabot with a cooldown, gitleaks in CI |
| `changelog` | One `changelog.d/` fragment per PR, a CI check with a `no-changelog` escape label, and a release command that folds them into `CHANGELOG.md` |
| `ui-geometry` | A Playwright layout check at 320, 390 and 1280 px that fails on new page overflow, clipped text, small or overlapping tap targets, uneven control rows and elements outside the viewport, against a committed baseline |
| `agent-docs` | An `AGENTS.md` skeleton with a code map the skill fills from your repo, `CLAUDE.md` importing it, `.agents/skills` shared with Claude Code, an ADR template, and a check for broken doc links, stale map and ADR paths, and oversized agent docs |
| `agent-loops` | `ship` and `babysit` skills that take a branch through local review, PR, AI review, CI and squash merge (auto-merge for low-risk PRs), plus a PR template |

`agent-loops` pulls in `agent-docs` and `ai-review`; `hooks` pulls in `quality`. `ai-review` and `opencodereview` are alternatives: `all` picks `ai-review`, and `opencodereview` (which leaves out `agent-loops`) is chosen by name. `ui-geometry` is for repos that serve a web UI. Supported: bun and pnpm projects on Node 22.18+.

## Install

### Claude Code plugin (recommended, updates itself)

```bash
claude plugin marketplace add lucasnsaraujo/repo-kit
claude plugin install repo-kit@repo-kit
```

Or in one step inside Claude Code:

```
/plugin install repo-kit --marketplace lucasnsaraujo/repo-kit
```

Run it with `/repo-kit:repo-kit`.

### skills.sh

```bash
npx skills add lucasnsaraujo/repo-kit
```

Copies the skill into your agent's skills folder; update with `npx skills update`. Run it with `/repo-kit`.

### Manual

```bash
git clone https://github.com/lucasnsaraujo/repo-kit ~/src/repo-kit
ln -s ~/src/repo-kit/skills/repo-kit ~/.claude/skills/repo-kit
```

`git pull` updates it. Run it with `/repo-kit`.

## Use

Open Claude Code in the project and run the skill. It walks seven steps, each with a completion check:

1. **Detect** the stack and any previous run.
2. **Choose** modules: all, or a list. Existing tools are marked as replaced or kept.
3. **Plan** the change and show every conflict before writing anything.
4. **Apply** the files and install the dev dependencies.
5. **Tailor** each module to the repo: fill `AGENTS.md` from real scripts and folders, write review rules for your risky areas, set CI lanes for a monorepo, wire the env loader, merge conflicts.
6. **Verify** with each module's checks plus `lint`, `typecheck`, `test` and `actionlint`.
7. **Owner steps**: the GitHub changes only you can approve, listed with exact commands. For example:

```bash
claude setup-token                                  # then:
gh secret set CLAUDE_CODE_OAUTH_TOKEN
gh variable set AI_REVIEW_GATE --body false         # flip to true after a few PRs
gh label create no-changelog
```

Work happens on a `chore/repo-kit-setup` branch, committed in logical steps.

### Updating a project later

Run the skill again. It reads `.repo-kit.json` and keeps your module selection.

- Files nobody touched update in place.
- Files you edited or adopted get a `<file>.repo-kit-new` proposal to merge by hand.

### The engine on its own

The mechanical part is a dependency-free script you can run directly:

```bash
KIT="node ~/src/repo-kit/skills/repo-kit/scripts/kit.ts"
$KIT detect                       # stack + recorded selection, as JSON
$KIT plan --modules all           # what apply would do; writes nothing
$KIT apply --modules ci,quality   # write, merge package.json/.gitignore, record hashes
$KIT check                        # managed files that are missing, edited or outdated
$KIT adopt <path>                 # take ownership of a file; later runs propose instead of write
$KIT remove <module>              # delete its untouched files and scripts, re-render the rest
```

## How the AI review works

The `ai-review` workflow runs Claude Code headless on a GitHub-hosted runner, signed in with your subscription token.

- **Instructions come from the base branch.** The system prompt, the per-folder `AGENTS.md` files and the rule fragments are read from the base commit. A pull request cannot rewrite the rules used to review it.
- **The reviewer only reads.** It gets `Read`, `Grep` and `Glob` over the checkout and over diffs computed beforehand. It has no shell and no network, and reads outside those folders are blocked. A separate job with a write token posts the comment and the status.
- **Findings have a lifecycle.** Each one is `NEW`, `REMAINS`, `RESOLVED` or `WITHDRAWN`. State lives in a hidden marker in the bot's own comment, and after the first review only the new commits are reviewed.
- **You can argue back.** Someone with write access comments `/ai-review` with the concrete reason a finding is wrong. A finding is withdrawn only when the reviewer verifies that reason in the code.
- **Only risky pull requests are reviewed.** `.github/ai-review/risk.json`, read from the base commit, lists globs for auth, payments, migrations, secrets, CI and dependencies. A pull request that touches none, with no P0/P1 left open, gets `AI review: success` ("low risk: review not required") without a model run; `/ai-review` still reviews it on request.
- **The gate is a commit status.** `AI review` fails on unresolved P0/P1 when `AI_REVIEW_GATE=true`. Until then it only comments.

## Prior art

Each module cites the files it follows in its `MODULE.md`. The main sources:

- [nightly-labs/openbot](https://github.com/nightly-labs/openbot): the AI review loop, the CI lane design, release-note fragments, and the ship/babysit skills (ideas rebuilt, no code copied).
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code): the stricter required-check aggregator and fail-open change detection.
- [astral-sh/uv](https://github.com/astral-sh/uv) and [DataDog/documentation](https://github.com/DataDog/documentation): split model and publish jobs, structured output, the commit-status gate.
- [copier](https://github.com/copier-org/copier), [shadcn/ui](https://github.com/shadcn-ui/ui), [cruft](https://github.com/cruft/cruft): answers files, never clobbering edits, drift checks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The module format is in [skills/repo-kit/reference/module-format.md](skills/repo-kit/reference/module-format.md).

## License

[MIT](LICENSE)
