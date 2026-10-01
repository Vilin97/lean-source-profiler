# Whole LeanPool source profile

[Open the public explorer](https://vilin97.github.io/lean-source-profiler/pool/).

The recording covers all **7,060 Lean source files** under `LeanPool/`, including
files not imported by a project's entry module: **213 registered projects plus
the Basic module**, grouped into 214 entries, and **3,232,537 physical source
lines**. Challenge, Solution, dependencies, and generated root index modules are
outside this inventory.

Click a project, folder, file, declaration, and source line to descend. Use the
breadcrumbs to return and the search box to find entries at the current level.
Small bars and declarations with no separate timing remain selectable in the
list. Every original source line can be selected, including lines without a
separately allocated timing.

## Duration and coverage

The full capture started **2026-09-28 03:26 PDT** and finished
**2026-09-30 11:00 PDT**: **55 hours 34 minutes elapsed**. This window includes
native builds, retries, export, interruptions, and recovery. The successful file
captures account for about **31 hours 46 minutes** of that time; neither number
is the duration of an ordinary parallel `lake build`.

All 7,060 files were captured successfully, with zero final failures. Native
builds covering every source file passed in all 214 groups. The source inventory
and source hashes matched the pinned checkout. A final uncached audit finished
at **2026-09-30 12:08 PDT**, after another **1 hour 7 minutes**, verifying all
**84,285,215 events** in approximately **162.1 GB of original recording data**.

The [coverage result](pool/coverage.json) and the
[public dataset manifest](pool/manifest.json) provide machine-readable evidence.
Every published source snapshot is checked against its inventory SHA256; the
manifest records the hash and size of each compressed public asset.

## What the bars measure

**Source-attributed time** partitions source-covered frontend wall time among
the recorded scopes. Concurrent scopes share an interval equally by active
thread; the deepest active scope on each thread selects the source anchor.
Intervals are counted once, so sibling widths add to their parent.

**Frontend time, including imports** also includes the remainder as imports and
unrecorded time. Files were captured independently and reload shared imports.
Summing their times does not measure the duration of a parallel pool build.

Source-line values use the first line of the recorded source span. A multiline
expression can have timing on its first line without separate timing on later
lines. These are attributed wall times with instrumentation overhead, rather
than independently sampled per-line CPU times or heartbeat counts.

A [repeatability experiment](REPEATABILITY.md) with five files and five measured
captures each found a median pairwise difference of 1.85% for file source time,
with a 95th percentile of 11.50%. This is a small sample, not a whole-pool error
bound. Declaration and line-anchor timings had larger outliers.

Internal operations were captured at per-file thresholds of 1, 10, or 100 ms;
source scopes were retained below the threshold. Twelve files needed a larger
profiling heartbeat allowance to accommodate instrumentation overhead. Those
files passed their uninstrumented native builds, and their original source and
repository options were unchanged. The allowance is disclosed in the file's
detail panel when applicable.

## Public snapshot

The public explorer includes **every file, declaration, source snapshot, and
source-line timing anchor** from the completed pool recording. It loads
compressed file summaries on demand, without requiring Lean or a server-side
profiler. Source text, names, timings, attribution status, and ranges are
preserved; machine-specific metadata is omitted and source paths are
repository-relative.

The full raw internal-operation traces and interval databases remain in the
local recording. They are not included in this static public snapshot. The
[smaller detailed trace example](https://vilin97.github.io/lean-source-profiler/examples/leanpool/)
demonstrates internal operation inspection separately.

To reproduce this public export from an audited recording:

```sh
python3 scripts/export-whole-pool.py /path/to/whole-pool-profile docs/pool
```

The exporter requires complete coverage, checks each source hash, preserves
source-level measurements, and writes deterministic gzip assets.

## Provenance and attribution

- LeanPool: [Vilin97/lean-pool](https://github.com/Vilin97/lean-pool/tree/38b8ba36899903cb7d3a42bb9f8a3f5c70fdb05f),
  commit `38b8ba36899903cb7d3a42bb9f8a3f5c70fdb05f`.
- Lean Source Profiler:
  [capture version](https://github.com/Vilin97/lean-source-profiler/tree/b1b4f8b0c942683da32513f92e3b27ab42827021),
  commit `b1b4f8b0c942683da32513f92e3b27ab42827021`, with native Lake setup and an
  export-time reference index that preserves matching references and trace order.
- Lean **4.34.0**, with LeanPool's pinned Mathlib and native per-module Lake options.
- Original source headers are retained unchanged. The public snapshot includes
  LeanPool's [license](pool/LEANPOOL-LICENSE), [notices](pool/LEANPOOL-NOTICE), and
  [project registry](pool/projects.yml). The profiler's MIT license does not
  replace the original source licenses or attribution.
