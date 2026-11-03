# Contributing

## Layout

```
.claude-plugin/         plugin and marketplace manifests
skills/repo-kit/
  SKILL.md              the steps the agent follows
  scripts/kit.ts        the engine CLI (Node 22.18+ or Bun, no dependencies)
  scripts/lib/          render, detect, modules, apply
  modules/<id>/         module.json, MODULE.md, templates/
  reference/            module format and template syntax
tests/                  bun:test suites for the engine and every module
```

## Setup

```bash
bun install
bun run check      # test, typecheck, lint, actionlint
```

## Changing a module

1. Read [the module format](skills/repo-kit/reference/module-format.md).
2. Write a test first in `tests/modules/<id>/`. It should go red on the bug or missing behaviour.
3. Change the module. TypeScript script templates hold no template tags, so tests import them directly.
4. Bump `KIT_VERSION` in `skills/repo-kit/scripts/lib/version.ts` and `version` in `.claude-plugin/plugin.json` when templates change. Projects use the version to tell an update from an edit.
5. Run `bun run check`. `tests/all-modules.test.ts` applies every module together and requires the result to pass its own Biome check.

## Adding a module

Create `skills/repo-kit/modules/<id>/` with `module.json`, `MODULE.md` (headings: Sets up, Tailor, Owner steps, Verify, Prior art) and `templates/`. Then add it to the table in `README.md` and the defaults in `SKILL.md`.
