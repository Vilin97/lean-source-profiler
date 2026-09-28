# Session format and queries

A directory/project capture produces this portable bundle of recording files:

```
my-session/
  session.json
  index.jsonl
  files/
    000000.leanprofile.json
    000001.leanprofile.json
```

Keep these files together. The manifest and index use relative paths for their recording references. Source locations inside individual recordings remain absolute; the standalone viewer uses stored source snapshots, while VS Code needs the corresponding checkout at those paths.

## Manifest

`session.json` has `schemaVersion: 2`, `kind: "lean-source-profile-session"`, the project root, selected target, start/end timestamps, `wallMs`, `plannedFileCount`, exclusion policy, toolchain versions and a `files` array. Every entry has an `id`, project-relative POSIX `path`, absolute `sourceFile`, and `status` (`ok` or `error`). Successful entries include their relative `profile`, `elapsedMs`, `captureWallMs`, `eventCount` and `declarationCount`; failures include an `error` message.

Session `status` is `complete`, `partial`, or `cancelled`. During capture it is partial. Completed files are checkpointed after each capture. A failed file does not terminate the session. Cancellation preserves completed files, but interrupted files have no completed entry. Capture refuses an existing output directory.

The default discovery policy skips hidden directories/files, `.lake`, `.git`, `node_modules`, `vendor`, `build`, `dist`, `lakefile.lean`, and directory-entry symlinks. An explicitly selected target is resolved to its real path. `profile --list` prints the selected file list before running Lean. Imports must already be compiled. This is not a Lake dependency build.

## Index

`index.jsonl` has one JSON object per line. `kind` is `file`, `folder`, `declaration`, or `tactic`. Common fields are `name`, `path` (relative POSIX), and `durationMs`. Declaration/tactic records also have one-based `line`/`endLine` and trace references. `eventId` identifies one representative event; `eventIds` lists the contributing outer trace scopes, including asynchronous work. Drill into all of them when explaining an aggregate cost.

- **File:** `durationMs` is the isolated Lean frontend's elapsed time including import loading and elaboration. `captureWallMs` also includes launching/compiling the driver, rendering expressions and exporting results.
- **Folder:** sum of descendant successful file durations, counting each file once. `path: "."` is the selected recording's root aggregate. Nested folder totals overlap: do not sum every folder row.
- **Declaration:** name and full UTF-16 source range come from Lean declaration metadata, excluding generated helpers. Duration is the union of recorded intervals inside that range, including asynchronous workers. Header/body/async scopes are retained even below the internal trace threshold. Nested declarations have inclusive overlapping durations. Declarations sharing a source range are labeled `attribution: "shared"` and list `sharedWith`; that does not provide independent timings for each name. Missing trace coverage is omitted rather than represented as zero time.
- **Tactic:** each exact source invocation span groups its recorded executions, unioning overlapping wrappers. Sequence wrappers spanning later statements are excluded. `name` is a short source excerpt, `declaration` is its nearest semantic declaration, and `eventIds` preserves disjoint attempts. `selfMs` belongs to the representative event, not a sum over all attempts. All timings are elapsed trace times, not CPU samples.

File runs are sequential and may repeatedly load the same imports. Folder percentages compare sums of isolated runs; they do not claim a build-critical-path breakdown. Capture overhead can be substantial on definitionally expensive proofs. Use separate uninstrumented runs for performance benchmark claims.

## CLI

From the repository root (or replace `node out/cli.js` with `lean-profile` after `npm link`):

```sh
node out/cli.js profile --project /path/to/project --output /tmp/my-session
node out/cli.js profile /path/to/project/Subfolder --output /tmp/subfolder-session
node out/cli.js view /tmp/my-session
node out/cli.js open /tmp/my-session
node out/cli.js query /tmp/my-session --kind file --limit 1 --json
node out/cli.js query /tmp/my-session --kind declaration --limit 10 --json
node out/cli.js query /tmp/my-session --kind tactic --path MyLibrary/Analysis --limit 10 --json
node out/cli.js query /tmp/my-session --kind folder --limit 10 --jsonl
```

`--json` returns a metadata object with completion status, completed/failed/planned counts, metric explanation, compatibility notes and a `results` array. `--jsonl` writes rows to stdout and the status metadata to stderr. Plain output is tab-separated. Capture logs go to stderr; stdout is the saved recording/manifest path. Partial captures exit 1; interrupt cancellation exits 130, termination cancellation 143. Viewing runs until Ctrl-C or extension shutdown.

`--path` filters an exact file or a subtree boundary; `Foo` matches `Foo/Bar.lean`, not `Foobar.lean`. Sort defaults to descending `durationMs`; `--sort selfMs` excludes records without that metric. Default limit is 20. Existing version-1 file recordings still work; older files need recapture for semantic declaration queries.

The CLI reads the compact index rather than loading every file's full trace. You can also use JSONL tools directly:

```sh
jq -s 'map(select(.kind == "file")) | max_by(.durationMs)' /tmp/my-session/index.jsonl
jq -s 'map(select(.kind == "declaration")) | sort_by(-.durationMs) | .[:10]' /tmp/my-session/index.jsonl
```

For a capture interrupted while checkpointing, the CLI restricts index rows to committed manifest entries and recomputes folder totals. Direct JSONL consumers should likewise join file paths against successful manifest entries when reading an active/incomplete session.
