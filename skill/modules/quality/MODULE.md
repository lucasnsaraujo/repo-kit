# quality

## Sets up

- `biome.json`: format and lint with Biome's `recommended` preset plus `noUnusedImports`, `noUnusedVariables`, `noExplicitAny`, `noFocusedTests` as errors, and the nursery rules `noFloatingPromises` and `noMisusedPromises`. Test files (`*.test.*`, `*.spec.*`) also load the five GritQL rules below. `vcs.defaultBranch` is the detected default branch, so `--changed` and `--staged` work.
- `tools/biome/rules/*.grit`, test files only, each an error:
  - `no-snapshot-assertions`: `toMatchSnapshot`, `toMatchInlineSnapshot`, `toThrowErrorMatchingSnapshot` and their inline and file variants.
  - `no-test-id-queries`: `getByTestId` and its `query`/`find`/`All` forms, and selectors that name `data-testid`.
  - `no-sleep-in-tests`: awaited `new Promise` around `setTimeout`, `setTimeout(ms)` from `node:timers/promises`, `sleep()`, `Bun.sleep()`, `waitForTimeout()`.
  - `no-module-mocking`: `vi.mock`, `vi.doMock`, `jest.mock`, `jest.doMock`, `jest.unstable_mockModule`, `mock.module`.
  - `no-class-style-assertions`: `toHaveClass`, `toHaveStyle`, `toHaveCSS`, and `toHaveAttribute("class" | "style", ...)`.
- `tools/biome/fixtures/<rule>.ts`: for each rule, the lines it must report end in `// flag`; the other lines are look-alikes it must leave alone. Excluded from lint, knip, and (by `// @ts-nocheck`) type errors.
- `scripts/check-lint-rules.ts` (`check:lint-rules`): runs each rule alone on its fixture and fails when the reported lines differ from the `// flag` lines, when a rule has no fixture or no marked line, or when `biome.json` does not load it.
- `scripts/debt-ratchet.ts`: the baseline rules for any per-file counter. A count above the baseline fails; a count below it fails until `--write` lowers the baseline; `--write` never raises a count, so raising one is a hand edit a reviewer sees; `--add=<check>` starts a check at its current counts.
- `scripts/type-ratchet.ts` (`types:ratchet`): for each strict option held in `tools/ratchet/types.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`), runs `tsc --noEmit --pretty false --<option>` and compares the errors per file to the baseline. `--project=<tsconfig>` (repeatable) replaces `tsconfig.json`.
- `knip.json`: knip defaults with the fixtures ignored and the ai-review scripts (run from the workflow, which knip cannot trace) as entry points.
- Scripts: `lint`, `lint:fix`, `check:staged`, `typecheck` (kept when the project has one), `knip`, `types:ratchet`, `check:lint-rules`. Dev dependencies: `@biomejs/biome`, `knip`, `typescript`.
- `.gitignore` gains `node_modules/` when missing; Biome reads the ignore file and stops when there is none.

## Tailor

1. **Replace the old linter and formatter.** If the project uses ESLint, Prettier or oxlint, move every rule that matters and has a Biome equivalent into `biome.json` (`biome migrate eslint --write` and `biome migrate prettier --write` do most of it), set `formatter` to the style the code already has (indent, `lineWidth`, quotes), then remove the old tools and their configs. Done when `<pm> run lint` is the only lint command in `package.json`, and `git ls-files | grep -E 'eslint|prettier'` prints nothing that is still used.
2. **Merge `biome.json.repo-kit-new`** into the existing `biome.json` when there is one: keep the project's `files.includes`, overrides and formatter, add the kit's rules and the test-file override with its five plugins. Done when no `*.repo-kit-new` from this module remains and `<pm> run check:lint-rules` passes.
3. **Get lint green on the existing code.** Run `<pm> run lint:fix`, commit that alone, then fix what remains. For a rule that would take a large rewrite, set it to `"warn"` in `biome.json` with a one-line reason instead of turning it off. Done when `<pm> run lint` exits 0.
4. **Settle knip.** Run `<pm> run knip`. Delete what is truly unused; for entry points knip cannot see (CLI bins, files loaded by name, framework conventions), add `entry` or `ignore` patterns to `knip.json`. Done when `<pm> run knip` exits 0 and every `knip.json` entry has a reason you can name.
5. **Start the type ratchet.** Run `<pm> run types:ratchet` once: it prints the `--add=` command for every strict option `tsconfig.json` leaves off. Run that command. For each option it reports as having no type errors left, set it to `true` in `tsconfig.json` and delete its key from `tools/ratchet/types.json`. A monorepo passes each project with `--project=`; put those flags in the `types:ratchet` script. Done when `<pm> run types:ratchet` exits 0 and `tools/ratchet/types.json` is committed.
6. **Check the Node version.** The scripts run as `node <file>.ts`, which needs Node 22.18 or newer. Done when `node --version` and `.nvmrc` (or `engines.node`) are at least 22.18.

## Owner steps

None.

## Verify

- `<pm> run lint`: exit 0.
- `<pm> run check:lint-rules`: one `ok` line per rule, exit 0.
- `<pm> run typecheck`, `<pm> run knip`, `<pm> run types:ratchet`: each exits 0.
- Add `expect(value).toMatchSnapshot();` to any `*.test.ts`, run `<pm> run lint`: it fails on that line with the snapshot message. Revert.

## Prior art

- GritQL plugins loaded only for test files through `overrides`, each rule with a `// flag` fixture: openbot `biome.json` (overrides with `plugins` for `**/*.test.ts`) and `tools/biome/anti-slop/rules` plus `fixtures`. Our five rules and their messages are written from scratch.
- Proving rules against fixtures in an isolated workspace so other rules cannot report: openbot `scripts/anti-slop-rules.test.ts` writes a temporary `biome.json`. Ours runs one rule at a time with the `none` preset and parses `--reporter=github`, which is stable, rather than the JSON reporter, which Biome 2.5 labels experimental. It also fails when `biome.json` does not load a rule, the gap a fixture alone does not catch.
- Baseline counts that only go down, `--write` to lower, `--add` to start, raising only by hand: openbot `scripts/debt-ratchet.ts` and `scripts/type-ratchet.ts`. Ours keeps a finished check in the baseline as `{}` and fails until the option is turned on, so finishing it cannot be forgotten, and refuses `--add` for an option `tsc --showConfig` shows as already on.
- Staged fixes through `check:staged` (`biome check --write --staged`): openbot `package.json`, used by the `hooks` module.
