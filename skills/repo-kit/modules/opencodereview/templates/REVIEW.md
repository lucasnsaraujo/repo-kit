# Review rules

OpenCodeReview reviews every pull request in this repository. It reads this file from the pull request's base commit, so a pull request cannot change the rules it is reviewed by. It applies these rules on top of its own review method: this file only says what matters here and what to leave alone.
{%if module:agent-docs%}

The project rules live in [AGENTS.md](AGENTS.md). Report a change that breaks one of them on the lines it touches.
{%endif%}

CI already runs <!-- fill: the checks CI runs, e.g. Biome, tsc, Vitest, knip -->. Do not report what those catch.

## <!-- fill: the riskiest area, e.g. Billing -->

<!-- fill: one line on what a bug here costs: lost data, leaked access, money, a broken released contract -->

Report a change that:

- <!-- fill: a failure mode specific to this code, naming a real file, function or invariant -->

## Tests

Report a test that still passes when the code it covers is deleted, or that only checks a mock was called when the result itself could be checked.

Do not report a missing test unless you can name the regression it would catch.

## Leave out

- Formatting, import order and naming that match the surrounding code.
- Generated files and lockfiles.
- <!-- fill: false positives this repository invites, e.g. intentional duplication or frozen copies -->
