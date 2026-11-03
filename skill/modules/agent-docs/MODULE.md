# agent-docs

## Sets up

- `AGENTS.md`: the root guidance every agent reads: communication, non-negotiables, commands, scoped checks, test policy, PR rules, and a pointer table. Sections for release notes and env settings appear when the `changelog` and `env` modules are selected.
- `CLAUDE.md`: one line, `@AGENTS.md`, so Claude Code and every other agent read the same file.
- `.agents/skills/README.md` and the symlink `.claude/skills -> ../.agents/skills`: one skills folder for all agents.
- `scripts/check-docs.ts` and the `check:docs` script: fail on a broken relative link or `#anchor` in any tracked `.md` file, and on an AGENTS.md over its line budget (root 300, nested 150).

## Tailor

1. **Merge what was there.** For each `*.repo-kit-new` this module left (`AGENTS.md`, `CLAUDE.md`), move every rule of the old file that still holds into the matching section of the new skeleton, then keep the result as `AGENTS.md`. When the old `CLAUDE.md` had content, move it into `AGENTS.md` and leave `CLAUDE.md` as the single line `@AGENTS.md`. Done when no `*.repo-kit-new` from this module remains and no rule from the old files was dropped without a reason you can name.
2. **Fill every placeholder from the real repo.** Replace each `<!-- fill: ... -->` with facts you read in the code: `package.json`, the test runner config, CI workflows, existing docs, the directory layout. Write rules as the target behaviour, and cache only what the agent cannot find with one lookup (the unwritten convention, the reason, the gotcha). Delete a placeholder whose section has nothing to add. Then mark the filled files as project-owned: `node <kit>/scripts/kit.ts adopt AGENTS.md .agents/skills/README.md`. Done when `grep -n "fill:" AGENTS.md .agents/skills/README.md` prints nothing.
3. **Name only commands that exist.** Every `<pm> run <script>` named in `AGENTS.md` is a key in `package.json` `scripts`. Replace or remove a line naming a script the project does not have (`test:changed` comes from the `tests` module and the pre-commit hook from `hooks`; the skeleton names them only when those modules are selected). Done when each script named in `AGENTS.md` is in `package.json`.
4. **Write the non-negotiables.** Find the 3 to 6 rules whose breach loses user data, breaks a released contract (public API, wire format, database schema, CLI flags), or leaks a secret. Each one names the file or test that guards it. Done when each bullet names a real path.
5. **Fill the pointer table.** Add one row per nested `AGENTS.md` and per doc an agent must read before changing an area. In a monorepo, write a nested `AGENTS.md` (at most 150 lines) for each package whose rules differ from the root. Done when `find . -name AGENTS.md -not -path "*/node_modules/*"` lists only files that appear in the table, plus the root.
6. **Set budgets only when needed.** When an existing doc cannot fit the default budget yet, create `scripts/docs-budget.json` with `{ "root": <n>, "nested": <n> }` and say why in the PR. Done when `check:docs` passes.
7. **Move skills.** When `.claude/skills` already existed as a folder, the symlink was not created. Move its skills into `.agents/skills/`, delete the folder, and run apply again. Done when `readlink .claude/skills` prints `../.agents/skills`.

## Owner steps

None.

## Verify

- `wc -l AGENTS.md` prints at most 300; 80 to 150 is the target for a filled skeleton.
- `grep -c "fill:" AGENTS.md` prints `0`.
- `cat CLAUDE.md` prints `@AGENTS.md`.
- `readlink .claude/skills` prints `../.agents/skills`.
- `<pm> run check:docs` exits 0 and prints `Checked links in N Markdown files and the AGENTS.md budgets.`
- Break a link on purpose (`[x](nope.md)` in any tracked `.md`, staged with `git add`): `check:docs` exits 1 and names the file and line. Revert it.

## Prior art

- Root `AGENTS.md` shape (communication, non-negotiable rules, scoped local checks with "CI owns the full suite", PR rules, pointer table to nested files): openbot `AGENTS.md` (sections "Non-negotiable", "Checks", "Pull requests", "Task-specific instructions"). The skeleton is shorter because the Tailor step fills it from the real repo.
- `CLAUDE.md` as `@AGENTS.md`: t3code `CLAUDE.md`.
- `.claude/skills -> ../.agents/skills`: openbot keeps skills in `.agents/skills/` and links `.claude/skills` to it.
- Commands point at `package.json` instead of restating it: openbot `AGENTS.md` "Checks" names scripts but leaves their flags to `README.md`; restated commands go stale.
- Link and anchor check over `git ls-files "*.md"`, skipping fenced code and web links, GitHub heading slugs with `-1` suffixes for repeats: openbot `scripts/check-doc-links.ts`. This script also checks links to non-Markdown files and reference-style definitions.
- AGENTS.md line budget: no studied repo has one. Added because every always-loaded line costs context on every turn, and openbot's 276-line root file shows how close a well-kept file gets to 300.
