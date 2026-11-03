# tests

## Sets up

- `vitest.config.ts`: Node environment and `tools/vitest/hermetic-setup.ts` as global setup. It is a plain object, so it loads without vitest's types; wrap it in `defineConfig` from `vitest/config` if you want editor hints.
- `tools/vitest/hermetic-setup.ts`: once per run, before any test worker starts, deletes every environment variable whose name looks like a credential (`TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `PRIVATE`, `KEY` as a word, `API_KEY`) and points `HOME`, `USERPROFILE` and the `XDG_*` folders at a fresh temporary directory, removed when the run ends. `HERMETIC_KEEP_ENV=NAME,OTHER` keeps named variables.
- Scripts:
  - `test`: `vitest run`.
  - `test:changed`: runs the tests that cover files changed since `origin/<default-branch>`. It first checks `git merge-base`, because when the diff fails vitest finds no tests and exits 0, which would report a pass that never ran.
  - `test:related`: `vitest related --run <files>`, for the tests that import the given files.
  - `smoke`: `node scripts/smoke.ts`.
- `scripts/smoke.ts` with `scripts/smoke.config.json`: starts the app with `start` (and `env`), polls `healthUrl` until it answers 2xx (stopping early if the app exits), runs each HTTP check (`url`, `method`, expected `status`, optional `bodyIncludes`), stops the app's process group, writes `.artifacts/smoke.json` with every result and the last 50 lines of app output, and exits 1 on any failure.
- `.gitignore` gains `.artifacts/`. Dev dependency: `vitest`.

## Tailor

1. **Move existing tests onto vitest.** If the project uses Jest or `bun test`, port the config (aliases, setup files, environment) into `vitest.config.ts` and rewrite the imports (`@jest/globals`, `bun:test`) to `vitest`. Keep `globalSetup` pointing at the hermetic setup and add the project's own setup files under `setupFiles`. Done when `<pm> run test` runs the same number of tests as the old runner did, and they pass.
2. **Fix tests that relied on the real environment.** A test that read a real token or a file in the real home now fails. Give it the value it needs through the test (an argument, a fake, a fixture file in the temporary home), or, for a variable a test truly needs from the outside, list it in `HERMETIC_KEEP_ENV`. Tools that keep caches under the home (Playwright browsers, for example) need their path variable set, such as `PLAYWRIGHT_BROWSERS_PATH`. Done when `<pm> run test` passes with `GH_TOKEN=fake <pm> run test` too.
3. **Point the smoke at the real app.** In `scripts/smoke.config.json`, set `start` to the command that serves the app (a production build when there is one), `env.PORT` and `healthUrl` to a free port and a route that answers only once the app is ready (one that touches the database if it has one), and replace the two sample checks with the three to five requests a user would notice breaking first. For a web UI, keep these HTTP checks for the server and add Playwright (`@playwright/test`) for the flows a user clicks through; for a library or CLI with no server, delete the smoke files and the `smoke` script. Done when `<pm> run smoke` exits 0 and `.artifacts/smoke.json` lists the real checks with `"ok": true`.
4. **Decide where the smoke runs.** If the app can start in CI, add `<pm> run smoke` as the last step of the `test` job in `.github/workflows/ci.yml`, and upload `.artifacts/smoke.json` with `actions/upload-artifact` when it fails. Done when a CI run shows the smoke step, or the reason it cannot run in CI is written in `AGENTS.md`.

## Owner steps

None.

## Verify

- `<pm> run test`: vitest runs and passes.
- `GH_TOKEN=leak <pm> run test` with a throwaway test asserting `expect(process.env.GH_TOKEN).toBeUndefined()` and `expect(os.homedir()).toContain("vitest-home-")`: passes. Delete the test.
- `<pm> run test:changed` on a branch that changed one source file: only the tests that import it run.
- `git remote remove origin` in a scratch clone, then `<pm> run test:changed`: exits non-zero instead of passing with no tests.
- `<pm> run smoke`: prints one `ok` line per check, exits 0, and writes `.artifacts/smoke.json`.

## Prior art

- `test:changed` guarded by `git merge-base` and `test:related` with `vitest related --run`: openbot `package.json` (`test:changed`, `test:related`). We drop its `--maxWorkers=1`, which suits a desktop app's heavy tests, not a default.
- Scrubbing credentials and moving the home before tests: openbot `tools/vitest/hermetic-setup.ts`, which runs as a per-file `setupFiles` entry and removes its home in `afterAll`. Ours runs as `globalSetup`: once per run in the main process, before any worker exists, so no module sees the real environment, and its teardown deletes the directory without importing vitest's API. We confirmed with vitest 5.1 that workers in both the `forks` and `threads` pools inherit the changed `HOME` and the removed variables.
- `forceRerunTriggers` stays at vitest's default: it makes `--changed` run every test when `package.json` or the vitest config changes, which is what a dependency or config change needs.
- Waiting on state rather than sleeping: the smoke polls the health URL and races the app's exit, the same rule `no-sleep-in-tests` in the `quality` module enforces in tests.
