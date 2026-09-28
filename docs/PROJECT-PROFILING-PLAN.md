# Project profiling design and delivery plan

## Capture

- `profile FILE` keeps the existing single-file recording. `profile DIRECTORY` recursively captures the directory; `profile --project ROOT` captures a project's own Lean files.
- Directory capture discovers files deterministically, excludes hidden directories (including `.lake`/`.git`), dependency/output folders, and symbolic links. It records the selected scope and exclusion policy.
- Each file runs sequentially in its Lake environment. Imports must already be compiled; discovery is not a Lake build and does not rebuild dependencies. Failures remain explicit, and other files continue. Cancellation retains completed files.
- A session directory contains `session.json`, individual `files/*.leanprofile.json`, and a queryable `index.jsonl`. Every completed file checkpoints the manifest and index. Existing output directories are never overwritten.

## Timing model

- The repository tree uses each successful file's Lean processing elapsed time, including loading imports. Folder totals sum descendant file times. Percentages identify their denominator (parent or all captured files). These are sequential isolated file runs, not a whole-project build wall-time profile.
- Capture wall time includes driver startup, trace rendering, and export and is shown separately.
- Declaration and tactic timings are inclusive recorded elapsed intervals. Source-based groups union overlapping intervals; nested tactics/declarations are not additive. Self time means recorded event time minus recorded child interval union, not CPU time.
- Declaration names/ranges come from Lean metadata. No heuristic text search is presented as semantic declaration attribution. Missing timing or source coverage is explicit.

## Two viewers

- VS Code can open a session, choose its file, and load the existing source overlays and nested operation details. A session command allows choosing another captured file.
- `view RECORDING` starts a local, loopback-only standalone viewer. It starts with repository folders, percentages, and durations; folders drill down and files open source and nested operations. Links can open the same file recording in VS Code.
- Viewer inputs are data, never executable HTML or commands. Source snapshots and existing stale-source guards remain in use.

## Agent-facing queries

- `query RECORDING --kind file|folder|declaration|tactic --limit N --json` returns sortable stable records with relative path, source location, duration, and links to underlying event IDs.
- `index.jsonl` supports direct JSONL tools without this CLI. Machine-readable stdout contains only results; capture progress goes to stderr.
- File failures and cancellation are represented in session metadata; queries must not imply omitted files were fast or successfully captured.

## Validation and release

- Test discovery/exclusions, deterministic ordering, path safety, failure continuation, cancellation/checkpointing, and query ranking against independent totals.
- Test semantic declaration names and timing ownership on fixtures and NS `meanField_add`.
- Verify repository viewer navigation, percentages, source/detail drilldown, and hostile-text escaping in a real browser.
- Test VS Code session selection/overlay and retain existing single-file regression checks.
- Package and install a versioned VSIX, refresh the macOS installer bundle, and document commands, schema, timing limits, and actual test results.
