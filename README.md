# repo-kit

A Claude Code skill that sets up a TypeScript repo (bun or pnpm) with a standard dev workflow, built from modules you pick:

| Module | What it adds |
|---|---|
| `agent-docs` | `AGENTS.md` skeleton, `CLAUDE.md` importing it, `.agents/skills` shared with `.claude/skills`, doc link and size check |
| `ai-review` | Claude Code reviews each PR using the owner's subscription token, posts P0–P3 findings, and gates merge on P0/P1 through an `AI review` status |
| `ci` | GitHub Actions with lanes picked from the diff and one required `All checks pass` job |
| `quality` | Biome with anti-slop test rules, knip, strict-TypeScript ratchet |
| `tests` | Vitest with a hermetic environment, changed-file runs, smoke script |
| `hooks` | pre-commit lint/format/typecheck/knip, pre-push changed tests |
| `env` | dotenvx-encrypted `.env.dev` / `.env.production`, typed loader |
| `supply-chain` | 3-day minimum release age, exact versions, install-script allowlist, grouped Dependabot |
| `changelog` | `changelog.d/` fragments per PR, CI check, release fold |
| `agent-loops` | `ship` and `babysit` skills, PR template |

## Install

```sh
ln -s ~/src/repo-kit/skill ~/.claude/skills/repo-kit
```

Then run `/repo-kit` inside a project. The skill walks through detect, choose, plan, apply, tailor, verify, and owner steps (`skill/SKILL.md`).

## Engine

`skill/scripts/kit.ts` runs on Node 22.18+ or Bun with no dependencies:

```sh
node skill/scripts/kit.ts detect --root <project>
node skill/scripts/kit.ts plan --modules all --root <project>
node skill/scripts/kit.ts apply --modules ci,quality --root <project>
node skill/scripts/kit.ts check | adopt <path> | remove <module>
```

It writes `.repo-kit.json` in the project with the kit version, the modules, and a hash for every file it wrote. A file is overwritten only when nobody edited it since; otherwise the new version goes to `<path>.repo-kit-new`.

## Development

```sh
bun install
bun test
bun run typecheck
bun run lint
```

Module layout and template syntax: `skill/reference/module-format.md`. Bump `KIT_VERSION` in `skill/scripts/lib/version.ts` when templates change.
