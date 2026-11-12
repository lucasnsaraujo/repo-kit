# ui-geometry

## Sets up

- `tests/geometry/geometry.ts`: `measurePage` runs in the browser and returns plain data (each visible element's box, scroll sizes, overflow, and whether it is interactive); six pure rules read that data:
  - `page-overflow`: the page is wider than the viewport.
  - `clipped-text`: an element with its own text overflows a box that hides overflow (`overflow: hidden` or `clip`), across or down. An element carrying `data-geometry-truncate`, or inside one, truncates on purpose and is skipped.
  - `small-target`: an interactive element under 44x44 px at a phone width (`phoneMaxWidth`, default 480). Links and controls inside a sentence are exempt, and a checkbox or radio is measured by its label when the label is larger.
  - `overlapping-targets`: two visible interactive elements overlap by more than 1 px, and neither contains the other.
  - `unequal-row-heights`: sibling controls (buttons, `role="button"`, text inputs, selects, textareas) in one row differ in height by more than 1 px. Links are not controls, so a tall logo beside a button passes.
  - `outside-viewport`: an element partly on screen sticks out past the left, right or top edge. Only the outermost one is reported. This catches what `overflow-x: hidden` on `body` hides from `page-overflow`. Elements inside a container that clips horizontally are exempt, and so are elements inside a sideways scroller that says so: `scroll-snap-type`, or the `data-geometry-scroll` attribute. A plain `overflow-y: auto` area does not count, because browsers make it scroll sideways too, which is the bug this rule is after.
- Offender keys: route, width, rule and an element descriptor built from the nearest landmark (`nav`, `main`, `form`, ...) and the element's id, `data-testid`, `aria-label`, `name`, `href` path or first 30 characters of text, with each run of digits masked as one `#`, so `Item 9` and `Item 10` share a key. Ids with digits are skipped, since frameworks generate them. No pixel value is part of a key, so a 1 px shift does not churn the baseline. Repeats get ` (2)`, ` (3)` in document order.
- `tests/geometry/geometry.check.ts`: the Playwright test file. For each width and route it opens the page with reduced motion, waits for `load`, the route's `waitFor` selector and the fonts, measures, and fails on offenders `baseline.json` does not list. Without `GEOMETRY_CONFIG` (a plain `playwright test` run) it reports one skipped test.
- `tests/geometry/geometry.config.json`: `command` (the Playwright command line), `routes` (paths, or `{ "path", "waitFor" }`), `widths` (320, 390, 1280), `phoneMaxWidth`, `viewportHeight`, and `ignore` (CSS selectors whose elements are not measured).
- `tests/geometry/baseline.json`: the accepted offenders, `{ "offenders": [{ "route", "width", "rule", "element" }] }`, sorted.
- `scripts/check-geometry.mts` and the scripts:
  - `check:geometry`: runs the command with `GEOMETRY_CONFIG` and `GEOMETRY_RESULTS_DIR=.artifacts/geometry`, then fails on a new offender, on a baseline entry that no longer occurs on a measured page (so the baseline only shrinks through a reviewed update), and on a run that measured no page.
  - `check:geometry --update`: rewrites the baseline from the run. Entries of pages the run measured are replaced; the rest are kept, so `node scripts/check-geometry.mts --update -- --grep /settings` updates one route. A failed Playwright run leaves the baseline alone.
- With the `ci` module: a `geometry` lane (`.tsx`, `.jsx`, style, `.html`, `.svg` files, `tests/geometry/`, `scripts/check-geometry.mts` and `playwright.config.*`) and a "Layout geometry" job that installs Chromium, runs `check:geometry`, and uploads `.artifacts/geometry` when it fails. With the `quality` module: `knip.json` lists `geometry.check.ts` as an entry.
- `.gitignore` gains `.artifacts/`. Dev dependency: `@playwright/test`.

## Tailor

1. **Add the geometry project to the Playwright config.** In the project's `playwright.config.ts` (create one with `webServer` and `use.baseURL` when there is none), add:

   ```ts
   {
     name: "geometry",
     testDir: "./tests/geometry",
     testMatch: "geometry.check.ts",
     // When pages need a session: the project that signs in, and the storage state it saves.
     dependencies: ["setup"],
     use: { ...devices["Desktop Chrome"], storageState: "<the setup project's storage state file>" },
   },
   ```

   The check sets the viewport itself. When the config lives in a package of a monorepo, make `testDir` relative to it and set `command` in `geometry.config.json` to run there, for example `pnpm --filter web exec playwright test --project=geometry`. Done when `GEOMETRY_CONFIG=$PWD/tests/geometry/geometry.config.json <pm> exec playwright test --list --project=geometry` lists one test per width and route.
2. **Pick the routes.** List the 5 to 15 pages users open most and the layouts that break first: tables, long forms, settings, dialogs that have a URL. Add `waitFor` with a selector that appears only once the page has its data, for every client-rendered page. Add to `ignore` the third-party widgets the app does not lay out (toasts, chat bubbles, dev overlays). Done when `<pm> run check:geometry` measures every route at every width, whatever it finds.
3. **Mark intentional truncation and carousels.** For each `clipped-text` offender that truncates on purpose (an ellipsis on a long name, a line clamp on a preview), add `data-geometry-truncate` to that element. For each `outside-viewport` offender inside a sideways scroller built on purpose (a carousel, a tab strip) that has no `scroll-snap-type`, add `data-geometry-scroll` to the scroller. Done when no offender left is intentional.
4. **Record the first baseline.** Run `<pm> run check:geometry --update`, read each offender, fix the ones that take a line of CSS, and run it again. Commit `baseline.json` with the rest, then mark the edited files as project-owned: `node <kit>/scripts/kit.ts adopt tests/geometry/geometry.config.json tests/geometry/baseline.json`. Done when `<pm> run check:geometry` exits 0 and `kit.ts check` lists neither file as `edited`.
5. **Run it in CI.** With the `ci` module, give the `geometry` job what the app needs to start (the same `env:`, services and build step as the e2e job), and add the files that change layout outside the lane's extensions (for example `tailwind.config.ts`, `app/**/layout.ts`) to its pattern. Without the `ci` module, add a job that runs `<pm> exec playwright install --with-deps chromium` and `<pm> run check:geometry`. Done when a pull request that changes a `.tsx` file shows "Layout geometry" green.
6. **Keep the project's checks green.** `geometry.check.ts` imports `./geometry` without an extension, which bundler resolution (Next.js, Vite) accepts. Under `nodenext` resolution, change it to `./geometry.ts` and turn on `allowImportingTsExtensions`. Done when the project's `typecheck` and `knip` pass.

## Owner steps

None, unless the app needs secrets to start in CI: then the same `gh secret set <NAME>` the e2e job already needed.

## Verify

- `<pm> run check:geometry` exits 0 and prints `measured N pages; no new layout offenders.`, with N = routes x widths.
- Give an element on the first route `style="width:2000px"`: `check:geometry` exits 1 and prints `new: / @320 page-overflow page`. Revert it.
- Delete one entry from `baseline.json`: `check:geometry` exits 1 and prints that entry as `new:`. Restore it.
- `<pm> exec playwright test --project=geometry` without `GEOMETRY_CONFIG` reports one skipped test and exits 0.

## Prior art

- agentes.chat `scripts/geometry/check.ts`, header comment only (idea, no code: that repository is AGPL-3.0): headless Chromium at a desktop, the narrowest phone and a common phone width; a committed baseline of accepted offenders with `--update`; a run that measured too little must not read as clean. Departures: this module drives the app's own Playwright project, so pages render with the real server, data and sign-in instead of captured states; the rules are pure functions over measured data, each proven by a fixture page and a look-alike that must pass; a baseline entry that no longer occurs fails until `--update` drops it.
- Ratchet that fails on improvements until the baseline is lowered: the `quality` module's `type-ratchet.mts`.
- 44x44 px targets and the exemption for links inside a sentence: WCAG 2.2 success criterion 2.5.5 (Target Size, Enhanced) and Apple's Human Interface Guidelines (44 pt hit targets).
