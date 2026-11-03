# Agent skills

A skill is a folder here with a `SKILL.md`: steps an agent loads only when a task needs them. Claude Code reads this folder through the `.claude/skills` symlink; Codex and other agents read `.agents/skills` directly. Write a skill once, here.

## Skill or AGENTS.md line

- A rule every task needs goes in `AGENTS.md`.
- A procedure only some tasks need (shipping a branch, a release, a migration) goes in a skill, so it costs context only when it runs.

## Writing one

1. Create `.agents/skills/<name>/SKILL.md`. Use a lowercase, hyphenated name that matches the folder.
2. Start with front matter:

   ```md
   ---
   name: release
   description: Cut a release. Bump the version, fold the release notes, tag, and publish. Use when asked to release, tag, or publish a version.
   ---
   ```

   The description decides when an agent loads the skill. Put the trigger words first, one per distinct case.
3. Write the body as numbered steps. End each step on a condition the agent can check, such as "`gh pr checks` shows every check as pass".
4. Point at files and scripts instead of copying them. A copy goes stale; the file does not.
5. Keep the body under about 200 lines. Move reference that only some runs need into a sibling file and link it from the step that needs it.

## Skills here

<!-- fill: one line per skill: `name`: when to use it. -->
{%if module:agent-loops%}
- [ship](ship/SKILL.md): take a finished branch through local review, pull request, AI review, CI, and squash merge.
- [babysit](babysit/SKILL.md): drive the AI review on one pull request until no valid finding remains.
{%endif%}
