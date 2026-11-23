# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/UpTo1M/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/UpTo1M/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` — one command-line tool that applies AI-written edits to a tree of text
files, to the specification in `SPEC.md`. Node 22, standard library alone.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

## The four formats

- **Unified diffs** — sections, hunks, `@@ -A[,B] +C[,D] @@`; hunks are matched
  by content, not by their (often wrong) line numbers: each hunk takes the
  occurrence nearest to `A - 1 + d`, where `d` is the drift of the hunks before
  it. Creates, deletes and moves (with `R old -> new` output) are supported,
  as are `\ No newline at end of file` markers.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  with the path taken from the nearest non-blank, non-fence line above the
  block (or the previous block's path). Empty old text creates the file; an old
  text that occurs more than once at its tier fails `ambiguous`.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `Add File`,
  `Delete File` and `Update File` sections, `*** Move to:`, `@@` anchors and
  `*** End of File` chunks, applied through a cursor that only moves forward.
- **JSON edits** — one array of edit objects, or JSON Lines: `create`,
  `str_replace` (exact, exactly once) and `insert` (by line number), with CRLF
  files read and written back in their own line breaks.

## Matching

Old lines are found at the first of three tiers at which they occur at least
once: tier 0 exact, tier 1 trailing whitespace ignored, tier 2 leading and
trailing whitespace ignored. `--strict` tries tier 0 only. Context lines are
always written as the file's own matched lines, never the patch's; at tier 2
the other new lines are re-indented from the patch's indent to the file's.

## Atomicity

Edits apply in the patch's order to the tree as earlier edits left it. A failed
edit changes nothing and the edits after it still run, so every failure is
reported (`failed: k of n edits`, exit 1). When any edit failed, no file is
written. `--check` does everything but write. Paths are checked for safety
before anything else about them.

## Practice results

100 of 100 practice checks pass (`node check.ts program/generator/practice.json`
in the kit): unified 30, search_replace 20, v4a 20, json 15, cli 15 —
practice score 1000.
