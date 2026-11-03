# Repository guidance

<!-- fill: two sentences. What this repository ships, who uses it, and the one thing a change must never break. -->

## Communication

- Keep working while a step needs nothing from the developer. Put status notes in the same message as your next action.
- Stop and ask before any step that cannot be undone or that leaves this repository: deleting data you did not create, force-pushing, pushing to `{%defaultBranch%}`, deploying, publishing, or sending messages.
- Mark each claim you could not confirm, and say where you looked.

**Non-negotiable** rules protect user data, released contracts, and secrets. Change one only on an explicit decision from the developer. Every other rule here is a default: follow the developer's preference and say which default you set aside.

## Non-negotiable

<!-- fill: 3 to 6 bullets. Each is a rule whose breach loses data, breaks a released contract, or leaks a secret, written as the target behaviour, with the file or test that guards it. Example: "Migrations keep every shipped schema readable (`db/migrations/`, `db/migrations.test.ts`)." -->
- Secrets stay out of the repository, logs, error messages, and test fixtures.

## Commands

`package.json` scripts are the source of truth: read them before you run anything, and run them with `{%pmRun%} <script>`. In a fresh worktree, run `{%installFrozen%}` first.

<!-- fill: only what package.json cannot tell: a command that needs a running service, a slow command and its cheap alternative, a required order. Delete this comment when there is nothing to add. -->

## Checks

Run the narrowest check that covers your change, one at a time. CI owns the full suite.

{%if module:tests%}
1. Tests: `{%pmRun%} test:changed` runs the tests affected by files changed since `origin/{%defaultBranch%}`. <!-- fill: the command that runs one test file. -->
{%else%}
1. Tests: <!-- fill: the command that runs one test file, and the one that runs the tests affected by a change. -->
{%endif%}
2. Lint and format only the files you changed: <!-- fill: e.g. `{%pmExec%} biome check --write <paths>`. -->
3. Types: <!-- fill: `{%pmRun%} typecheck`, or the per-package command in a monorepo. -->
4. Docs: after you edit Markdown, run `{%pmRun%} check:docs`. It fails on a broken relative link or anchor, and on an AGENTS.md longer than its budget (300 lines at the root, 150 nested).
{%if module:hooks%}
5. Commit through the pre-commit hook: it runs `check:staged` on the staged files. When it fails, fix the cause and commit again; `--no-verify` is off limits.
{%endif%}

A change is done when the tests that cover it pass, the changed files lint and type-check clean, and your report lists the checks you ran and the checks you left to CI.

## Tests

- Test behaviour through public interfaces: the exported function, the route, the command, the rendered screen.
- Each test must go red when the feature breaks in a way a user or caller would notice. A test that restates a constant, a type, a mock, or the framework does not earn its place.
- For a bug, first write the test that goes red on the bug. Green is the proof of the fix.
- Wait for state, an event, or a promise, not for elapsed time.
- Mock only boundaries this repository does not own: network, clock, third-party APIs.

<!-- fill: where tests live, file naming, fixtures and helpers, anything the runner config does not tell. -->

## Pull requests

- Open a pull request only when the developer asks.
{%if module:agent-loops%}
- Write the body from `.github/pull_request_template.md` and remove the sections it says to remove.
- To take a finished branch to `{%defaultBranch%}`, follow the `ship` skill. For the AI review loop alone, follow `babysit`.
{%else%}
- <!-- fill: the PR template path, or delete this line. -->
{%endif%}
- Under Verification, list each check you ran with its result, and the checks you left to CI.
- For a visible change, attach before and after screenshots to the pull request, not to the repository.
- A lint or type escape (`biome-ignore`, `eslint-disable`, `@ts-expect-error`, `@ts-ignore`, an `any`, or a cast that bypasses the checker) needs a named reason in the pull request. Fix the cause first.
{%if module:changelog%}

## Release notes

Write the notes for each change a user can see in a new `changelog.d/<branch>.md` file, with `-` for `/`, as [changelog.d/README.md](changelog.d/README.md) shows. `CHANGELOG.md` changes only at release time, through `{%pmRun%} changelog:release <version>`. CI fails a pull request with no notes unless it has the `no-changelog` label.
{%endif%}
{%if module:env%}

## Environment settings

- Settings live in two committed, encrypted files: `.env.dev` and `.env.production`. Add new settings to them; one more env file is one more place for a secret to leak.
- The root `.env.keys` holds the only private keys, one per file, and stays ignored. Pass `-fk .env.keys` to every dotenvx command so it reuses them instead of making new ones: `{%pmExec%} dotenvx set <KEY> <value> -f .env.dev -fk .env.keys`.
- Development runs without `.env.keys` on safe defaults. Production credentials never appear in `.env.dev`.
- Read settings through the typed loader <!-- fill: path to the env loader -->. Keep secret values off the screen: no `dotenvx get`, no `echo`.
{%endif%}

## Where to look

Read the AGENTS.md of each directory you change before you edit it.

<!-- fill: one row per nested AGENTS.md or doc an agent must read, e.g. | [src/api/AGENTS.md](src/api/AGENTS.md) | Routes, request schemas, error codes |. Add rows to the table and delete this comment. -->

| File | Scope |
| --- | --- |
| [.agents/skills/README.md](.agents/skills/README.md) | Agent skills: where they live and how to add one |
