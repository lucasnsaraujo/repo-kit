# Module format

A module is a folder under `skill/modules/<id>/` with three parts:

```
modules/<id>/
  module.json   what the apply engine writes and merges
  MODULE.md     what the agent does around it: tailor, owner steps, verify
  templates/    files copied into the project at the same relative path
```

## module.json

```json
{
  "id": "ci",
  "summary": "One line shown in the module menu.",
  "requires": ["other-module"],
  "files": [
    { "path": ".github/workflows/ci.yml" },
    { "path": "bunfig.toml", "when": "bun" },
    { "path": ".githooks/pre-commit", "executable": true }
  ],
  "symlinks": [{ "path": ".claude/skills", "target": "../.agents/skills" }],
  "packageScripts": { "lint": "biome check --max-diagnostics=none ." },
  "packageFields": { "trustedDependencies": [] },
  "lines": [{ "path": ".gitignore", "lines": [".env.keys"] }],
  "devDependencies": ["@biomejs/biome"]
}
```

| Field | Engine behaviour |
|---|---|
| `requires` | Selected automatically, applied first. `remove` refuses while a dependent is selected. |
| `files` | Rendered and written. A file is overwritten only when the kit wrote it and nobody edited it since (hash match). Otherwise the new version lands in `<path>.repo-kit-new` for the agent to merge. `when` takes a template condition. |
| `symlinks` | Created when the path is free. An existing different path is reported, never replaced. |
| `packageScripts` | Added when the name is free. A different existing command is reported as `script-conflict`. Values are rendered. |
| `packageFields` | Top-level `package.json` keys added when absent. |
| `lines` | Appended to the file when missing (exact line match). Path is rendered. |
| `devDependencies` | Names only. The plan prints one install command so the package manager picks versions under the project's release-age policy. |

## Template syntax

`{%name%}` substitutes a variable. Block tags sit alone on their line:

```
{%if bun%}
...
{%else%}
...
{%endif%}
```

`{%if !name%}` negates. Blocks nest. An unknown variable in `{%name%}` is an error; an unknown condition is false. The delimiters do not collide with `${{ }}` (GitHub Actions) or `[[ ]]` (Bash).

Variables:

| Name | Value |
|---|---|
| `pm` | `bun` or `pnpm` |
| `bun`, `pnpm` | booleans |
| `pmRun` | `bun run` / `pnpm run` |
| `pmExec` | `bunx` / `pnpm exec` |
| `installFrozen` | `bun install --frozen-lockfile` / `pnpm install --frozen-lockfile` |
| `defaultBranch` | from `origin/HEAD`, else `init.defaultBranch`, else `main` |
| `nodeVersion` | from `.nvmrc`, `.node-version`, `engines.node`, else `24` |
| `monorepo`, `library` | booleans |
| `module:<id>` | true for every selected module |

## Script templates

TypeScript templates hold no template tags, so the kit's own tests import and typecheck them. They run as `node <file>.ts` (Node 22.18+ strips types), so they use only `node:` imports, erasable syntax and `.ts` import extensions. Configuration they need comes from arguments, environment variables, or a JSON file next to them.

## MODULE.md

Fixed headings, in this order:

1. `## Sets up`: the files and behaviour, one line each.
2. `## Tailor`: the judgment work the engine cannot do (merge `*.repo-kit-new` files, fill placeholders from the real repo, map scripts). Each step ends on a checkable completion criterion.
3. `## Owner steps`: secrets, repository settings, labels. Each with the exact `gh` command. The agent runs them only after the owner says yes.
4. `## Verify`: commands with what pass looks like.
5. `## Prior art`: the repos and files each design choice follows, or why it departs.
