# Unreleased notes

Each pull request writes its release notes in its own file in this folder, so two pull requests never edit the same lines of `CHANGELOG.md`. Name the file after the branch, with `-` for `/`: branch `fix/empty-search` writes `changelog.d/fix-empty-search.md`.

## Format

One or more groups, each a `###` heading followed by bullets. The groups are the ones of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

| Group | For |
| --- | --- |
| Added | new features |
| Changed | changes to existing behaviour |
| Deprecated | features that will be removed |
| Removed | features removed now |
| Fixed | bug fixes |
| Security | vulnerabilities fixed |

```md
### Fixed

- Search shows results again after you clear the filter. Before, the list stayed empty
  until a reload.
```

Write each bullet for the people who use the product: what they can do now, or what works again. Leave out file names, function names, and ticket numbers. A bullet can wrap onto indented lines.

## Rules

- `{%pmRun%} changelog:check` validates every file here. CI runs it on each pull request and also fails a pull request that adds no notes.
- A pull request with no change a user can see gets the `no-changelog` label instead of a file.
- `{%pmRun%} changelog:release <version>` moves every file into a new `## [<version>] - <date>` section of `CHANGELOG.md`, grouped in the order of the table above, and deletes the files. It refuses when there are no notes.
