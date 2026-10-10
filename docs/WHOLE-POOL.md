# Whole LeanPool source profile

[Open the public explorer](https://vilin97.github.io/lean-source-profiler/pool/).

LeanPool is recorded weekly on an Azure VM, starting Monday at 02:00 UTC. The
explorer shows the most recent **complete, audited** recording. Its header
reports the file count, completion date and failures, and its footer identifies
the LeanPool commit, profiler commit and Lean version. The
[dataset manifest](pool/manifest.json) and [coverage audit](pool/coverage.json)
provide the current counts and provenance. The [date badge](pool/badge.json)
changes only when a new audited recording is published.

The inventory includes every Lean source file under `LeanPool/`, including files
outside each project's public entry imports. Challenge, Solution, dependencies,
hidden directories and generated root index modules are outside the scope.
Files are grouped by their first component under `LeanPool/`; root modules such
as Basic have their own group.

Click a project, folder, file, declaration and source line to descend. Use the
breadcrumbs to return and the search box to find entries at the current level.
Small bars and declarations without separate timing remain selectable in the
list. Every original source line can be selected.

## Capture and recovery

The [VM job](https://github.com/LeanPool/lean-pool/tree/main/scripts/weekly-profile)
pins current LeanPool and profiler commits, downloads the pinned Mathlib cache,
and natively builds every inventoried source module. The profiler's compact
capture retains semantic declarations, source ranges, thread IDs and source
scopes. It uses the module's native Lake setup and options without changing
source files or repository settings.

A run may take more than 24 hours and has no runtime timeout. Successful files
are checkpointed with source, setup, recording and summary hashes. Failures
retry on the same commits and reuse valid checkpoints; interrupted jobs resume
after VM reboot. Before export, a fresh audit validates every recording and
recomputes every summary. Incomplete coverage leaves the previous snapshot
published. An ordinary Git push publishes the dataset to GitHub Pages while
preserving the viewer's current HTML, JavaScript and CSS.

The first public recording, from September 2026, used detailed tracing: 7,060
files in 214 groups took 55 hours 34 minutes including builds, retries and
recovery. These historical numbers do not describe subsequent weekly captures.
The current manifest records the latest recording's elapsed time and coverage.

## What the bars measure

**Source-attributed time** partitions source-covered frontend elapsed time.
Concurrent source threads share overlapping intervals equally; the deepest
active event on each thread selects the source start line. Each interval is
counted once, so sibling widths add to their parent. A source anchor is assigned
to the smallest semantic declaration containing its range; remaining source
scopes have their own group. Shared declaration ranges have a single bar.

**Frontend time, including imports** also includes imports and unrecorded
frontend time as a separate child. Files are captured sequentially and reload
shared imports. Their sum is not the duration of a parallel pool build.

Multiline expressions can have timing on their first line without a separate
timing on later lines. Declaration inclusive timings are shown separately and
can overlap; the bars use the partition above. Timings include instrumentation
and VM scheduling overhead and are not independently sampled per-line CPU
times or heartbeat counts. [Capture and clock definitions](LOW-OVERHEAD.md).

## Reproduce a recording and export

With Node.js 20+, Python 3, Git and the project's installed Lean toolchain:

```sh
npm ci
npm run build
# From the pinned LeanPool checkout, build/download the Mathlib cache first:
# lake exe cache get
node scripts/capture-whole-pool.cjs /path/to/lean-pool /data/whole-pool-recording
python3 scripts/export-whole-pool.py /data/whole-pool-recording /data/public-pool
```

The capture command resumes an existing recording only if its pinned source
inventory, project configuration and profiler commit are unchanged. The export
requires complete coverage, verifies source hashes and writes deterministic
gzip assets. Its manifest records each public asset's size and SHA256.

The public snapshot preserves source text, declarations, ranges and timing
anchors, with repository-relative paths. Raw captures and build receipts stay
on the VM. Original source headers, LeanPool's license, notices and project
registry are retained; the profiler's MIT license does not replace their
licenses or attribution. The viewer fetches fresh snapshots and clears cached
file summaries when reloading.
