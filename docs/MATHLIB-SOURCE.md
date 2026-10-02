# Complete Mathlib source profile

[Open the Mathlib source explorer](https://vilin97.github.io/lean-source-profiler/mathlib-source/).
The explorer contains all **8,556 source files**, organized into 33 groups,
with descent through folders, files, declarations, and individual source
lines. It includes `Mathlib.lean`, `Mathlib/Init.lean`, and
`Mathlib/Tactic.lean`. Dependencies are outside this inventory.

## Source identity and coverage

The snapshot is Mathlib commit
[`726a7f1e86c481739c97cb90f5acb25f311f5ec8`](https://github.com/leanprover-community/mathlib4/tree/726a7f1e86c481739c97cb90f5acb25f311f5ec8),
using Lean **4.35.0-rc3**. Its 8,556 files contain **2,343,682 physical lines**.
Every inventory file passed native compilation with its original Lake setup,
then produced a successful source capture. No Lean source or linter settings
were changed.

The final audit read all 8,556 recordings afresh, with no reused audit results.
It checked source hashes, declaration/source mappings, timing allocations,
and operation indexes. It found no missing or failed files. The recordings
contain **43,761,695 events** and occupy **85,090,245,851 bytes** before the
compact public export.

[Coverage](mathlib-source/coverage.json) and the
[manifest](mathlib-source/manifest.json) provide the pinned commit, complete
file inventory, source hashes, compressed asset hashes, and capture settings.
The public payloads contain source snapshots and declaration/line timing
summaries. Full raw operation traces remain in the preserved capture archive.
The source snapshots retain Mathlib's [license](mathlib-source/MATHLIB-LICENSE).

## Timings and elapsed time

The session began on **October 1, 2026 at 16:23:56 UTC** and completed on
**October 2 at 14:20:30 UTC**: **21 hours 56 minutes 34 seconds elapsed**.
That interval includes the pilot, native group builds, tracing, export,
per-file audits, and storage transfers. The final full audit ran afterward,
from 14:20:53 to 15:07:57 UTC, taking about **47 minutes**.

The sum of the file frontend timers is **21,237,706 ms** (about 5 hours
54 minutes). The sum of source-attributed time is **7,943,480 ms** (about
2 hours 12 minutes). These are sums of isolated file measurements; they are
not the elapsed time of a parallel library build.

**Frontend time** includes import loading and elaboration, ending before
trace formatting and export. **Source-attributed time** comes from recorded
source scopes. The allocator divides overlapping active scopes before
assigning time to their deepest source anchors. Unrecorded work and costs
without a source anchor explain why the source total is smaller. Line bars
show attributed elapsed time, rather than independent CPU timers.

Internal operations were recorded with a **1 ms threshold**. Instrumentation
adds overhead. Repeatability, instrumentation overhead, and agreement with
another profiler are separate questions; see the
[LeanPool repeatability experiment](REPEATABILITY.md) and the
[Radar comparison](PROFILING-COMPARISON.md).

A clock check after source capture, during the local native benchmark,
observed Linux's monotonic timer running about **4.45% faster** than Windows's
high-resolution timer. Original timings remain unrescaled. This observation
does not retrospectively calibrate the source capture or establish a
whole-corpus error bound. The comparison methods preserve the clock samples.

## Capture configuration

The capture uses profiler commit
[`b1b4f8b0c942683da32513f92e3b27ab42827021`](https://github.com/Vilin97/lean-source-profiler/tree/b1b4f8b0c942683da32513f92e3b27ab42827021),
with a driver adapted to the pinned toolchain. The default driver SHA-256 is
`ea0ad06acf1fd426e48ee191f1862fdf009260f5ca582b2dcd73633acfe5de6f`
and was used for **8,555 files**. `LEAN_NUM_THREADS` was unset for source
capture; this records use of the toolchain default without asserting its
numeric thread count.

One file,
`Mathlib/CategoryTheory/Abelian/GrothendieckCategory/EnoughInjectives.lean`,
needed profiling-only allowances of `maxHeartbeats=2000000` and
`synthInstance.maxHeartbeats=200000`. That source first passed native
compilation without the allowances. Its traced driver SHA-256 is
`58b6405822e1b39b062163b9177be652b6c15fad3fcf7231309b8810db9838e6`.
The manifest identifies this exception. The native Radar measurements use
the original options.

## Using the explorer

Choose a group, descend through its folders and files, then select a
declaration and a source line. Switch between frontend time and
source-attributed time to see their different boundaries. Links can select
a file and line directly, including lines without a recorded cost; for
example, [Tilde line 555](https://vilin97.github.io/lean-source-profiler/mathlib-source/?path=Mathlib%2FAlgebraicGeometry%2FModules%2FTilde.lean&line=555).

[The separate Radar explorer](https://vilin97.github.io/lean-source-profiler/mathlib/)
shows published whole-file instruction counts and line counts at the same
Mathlib commit. Radar's dataset does not contain declaration or source-line
timings. [Compare the measurements](https://vilin97.github.io/lean-source-profiler/compare/)
with the source profile and local runs of the public Radar code.
