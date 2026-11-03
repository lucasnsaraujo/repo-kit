# supply-chain

## Sets up

- bun: `bunfig.toml` with `exact = true` and `minimumReleaseAge = 259200` (seconds, 3 days), plus a commented `minimumReleaseAgeExcludes` example.
- pnpm: `pnpm-workspace.yaml` with `minimumReleaseAge: 4320` (minutes, 3 days), `saveExact: true`, and an empty `allowBuilds` map, so no dependency runs an install script until someone allows it by name.
- `.github/dependabot.yml`: weekly package updates, minor and patch in one group, majors ignored, `cooldown.default-days: 3` to match the release age; monthly `github-actions` updates keep SHA-pinned actions and their version comments current.
- When this module is selected, the gitleaks CI job (`ci` module) and the gitleaks pre-commit step (`hooks` module) turn on as well; they live in those modules.

## Tailor

1. **Use one update bot.** When `renovate.json`, `.github/renovate.json`, `renovate.json5`, or `.renovaterc` exists, delete `.github/dependabot.yml` (or its `.repo-kit-new`) and set Renovate's `minimumReleaseAge` to `"3 days"` instead. When a `dependabot.yml` already existed, merge the kit's `cooldown`, `groups`, `ignore`, and `github-actions` entries into it. In a monorepo, list every package folder under `directories:`. Done when exactly one of Dependabot or Renovate is configured and no `*.repo-kit-new` from this module remains.
2. **Merge the pnpm settings into an existing workspace file.** In a pnpm monorepo, `pnpm-workspace.yaml` already exists, so the kit wrote `pnpm-workspace.yaml.repo-kit-new`. Copy its settings into the existing file next to `packages:` and delete the proposal. When the project pins pnpm below 10.26 (`packageManager` in `package.json`), write `onlyBuiltDependencies: []` instead of `allowBuilds: {}` and `save-exact=true` in `.npmrc` instead of `saveExact`; pnpm 11 removed `onlyBuiltDependencies`. Done when `pnpm config get minimumReleaseAge` prints `4320`.
3. **Allow install scripts by name (bun).** Add `"trustedDependencies": []` to `package.json` when it has none. An explicit list replaces Bun's built-in allowlist, and an empty one blocks every script. Then run `bun install` and read `bun pm untrusted`: it lists the dependencies whose scripts were blocked. Add a package to `trustedDependencies` only when the project breaks without its script (a native addon such as `better-sqlite3`, or a package that downloads its platform binary at install time), and write one line in `bunfig.toml` saying why. Done when `bun install --frozen-lockfile` passes, the app and tests still run, and every entry has its reason.
4. **Allow install scripts by name (pnpm).** Run `pnpm install`. pnpm 11 fails with `ERR_PNPM_IGNORED_BUILDS` and names each blocked package (pnpm 10 warns). Set `<name>: true` under `allowBuilds` only for packages the project needs built, and `<name>: false` for the rest, so the next install is quiet. Done when `pnpm install --frozen-lockfile` passes with no ignored-builds message.
5. **Exempt your own packages.** When the project depends on packages its own team publishes, add them to `minimumReleaseAgeExcludes` (bun) or `minimumReleaseAgeExclude` (pnpm), so a fix you publish lands without the wait. Done when each exemption is a package the team owns.

## Owner steps

- Turn on Dependabot alerts and security updates (security updates ignore the cooldown):

  ```sh
  gh api -X PUT repos/{owner}/{repo}/vulnerability-alerts
  gh api -X PUT repos/{owner}/{repo}/automated-security-fixes
  ```

## Verify

- bun: `bun pm untrusted` lists only packages you chose to leave blocked, and `bun install --frozen-lockfile` exits 0.
- pnpm: `pnpm config get minimumReleaseAge` prints `4320`, and `pnpm install --frozen-lockfile` exits 0 with no `Ignored build scripts` line.
- A version younger than 3 days is refused: find one with `npm view <package> time --json`, then `bun add <package>@<that version>` or `pnpm add <package>@<that version>` fails with a release-age error. Revert the attempt.
- After the push to the default branch, the repository's Insights > Dependency graph > Dependabot tab lists both ecosystems with a recent check and no configuration error.

## Prior art

- `exact = true`, `minimumReleaseAge = 259200` with a comment on why 3 days, `minimumReleaseAgeExcludes` for the maintainer's own package, and `trustedDependencies` as an explicit allowlist with a reason per entry: openbot `bunfig.toml`.
- Dependabot weekly, one group for minor and patch, majors ignored, `cooldown.default-days: 3` matched to the release age, monthly `github-actions`: openbot `.github/dependabot.yml`; the `github-actions` group and the per-ecosystem cooldown also follow vercel/ai `.github/dependabot.yml`.
- Units checked against the docs on 2026-11-03: bun `install.minimumReleaseAge` is in seconds (bun.com/docs/runtime/bunfig); pnpm `minimumReleaseAge` is in minutes, added in 10.16, default 1440 in pnpm 11 (pnpm.io/settings/dependency-resolution). pnpm 11 replaced `onlyBuiltDependencies` with `allowBuilds` (pnpm.io/blog/releases/11.0), so the kit departs from openbot's bun-only shape and writes `allowBuilds`. Checked with pnpm 10.12.2 (ignores the unknown keys, installs) and pnpm 11.28.10 (honours `saveExact`, blocks esbuild's build script with `allowBuilds: {}`).
