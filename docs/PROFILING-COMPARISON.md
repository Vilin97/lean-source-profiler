# Source profiling compared with Radar

[Open the comparison explorer](https://vilin97.github.io/lean-source-profiler/compare/).
It compares our complete source captures with hosted Radar measurements and
local measurements made with the unchanged public Radar measurement code.
All joins use the same source commits and exact inventories: **8,556 Mathlib
files** and **7,060 LeanPool files**, with no missing or failed captures.

Mathlib is pinned to `726a7f1e86c481739c97cb90f5acb25f311f5ec8`
(Lean 4.35.0-rc3). LeanPool is pinned to
`38b8ba36899903cb7d3a42bb9f8a3f5c70fdb05f` (Lean 4.34).
The LeanPool comparison excludes the aggregate `LeanPool.lean`, which was
outside its original profile inventory.

Radar's [implementation](https://github.com/leanprover/radar) and the
[measurement scripts](https://github.com/leanprover-community/mathlib4/tree/726a7f1e86c481739c97cb90f5acb25f311f5ec8/scripts/bench)
are public. The local runs preserve those script bytes, use the public
`instructions:u` counter and lakeprof module timings, and request every
inventory source explicitly. Sources are hashed before and after compilation.
Dependencies are cached, root outputs start fresh, and native builds set
`LEAN_NUM_THREADS=4`; Lake determines actual job concurrency.

Select a dataset, choose source or frontend time against instructions or
native module wall time, and switch between files and project groups. Each
point links to the source explorer and the source at its pinned commit.

## File comparisons

Columns labeled ‘vs’ show Spearman rank correlation.

| Dataset | Matched files | Source vs instructions | Frontend vs instructions | Source vs wall time | Frontend vs wall time | Source/instruction share distance |
|---|---:|---:|---:|---:|---:|---:|
| Mathlib · hosted Radar | 8,556 | 0.9683 | 0.9320 | 0.7599 | 0.8047 | 14.08% |
| Mathlib · local Radar code | 8,556 | 0.9678 | 0.9334 | 0.9077 | 0.9641 | 14.15% |
| LeanPool · local Radar code | 7,060 | 0.9664 | 0.9322 | 0.9138 | 0.9546 | 17.33% |

## Aggregate comparisons

Mathlib uses 33 inventory groups; LeanPool uses 214. Each aggregate is the sum of its matched files.

| Dataset | Matched groups | Source vs instructions | Frontend vs instructions | Source vs wall time | Frontend vs wall time | Source/instruction share distance |
|---|---:|---:|---:|---:|---:|---:|
| Mathlib · hosted Radar | 33 | 0.9916 | 0.9870 | 0.9820 | 0.9903 | 4.25% |
| Mathlib · local Radar code | 33 | 0.9916 | 0.9870 | 0.9913 | 0.9953 | 4.26% |
| LeanPool · local Radar code | 214 | 0.9701 | 0.9184 | 0.9314 | 0.9937 | 10.79% |

## Local reproduction of hosted Radar instructions

All **8,556 files** have both local and hosted counts. Rank correlation is **1.0000**; normalized share distance is **0.14%**. The median local/hosted instruction ratio is **1.0057**, with the 5th–95th percentile range **1.0013–1.0181**. These describe the two measured runs. Compiler startup, imports, runtime scheduling, and system libraries can affect instruction counts even when source bytes match.

## Paired frontend instrumentation controls

The stratified experiment completed **21 files**, with one warm-up per mode and **four measured runs per mode**. It sampled two files from each instruction-count octile, the four most expensive files, Init, and Tilde, removing duplicates. The median frontend overhead was **4.03%**, with a 5th–95th percentile range of **0.25%–26.92%**. Each file's overhead is 100 × (mean instrumented frontend time / mean baseline frontend time − 1). The two modes retain the same frontend calls, async settings, and snapshot settings; the baseline removes the added tracing options and environment wrappers. The stopwatch excludes trace export. Whole-process counters also include driver initialization, so their boundary differs from the frontend timer. This sample does not establish a whole-corpus error bound.

## Frontend repeatability in the stratified sample

Across the same **21 files**, four instrumented measured runs per file produced **126 pairwise comparisons**. The median difference was **1.28%**, the 95th percentile **5.53%**, and the maximum **16.63%**. Each difference is 100 × abs(a − b) / ((a + b) / 2), and all six pairs per file are included after warm-up. These repeat the frontend stopwatch through the original driver's stopTime; trace export is excluded. They do not repeat declaration or source-line allocation. The methods also include baseline repeatability, per-file timers, and coefficients of variation. Observed percentiles are not confidence bounds for the entire library.

## Clock observation

A probe after source capture, during the native Mathlib run, found Linux's
monotonic elapsed timer running about **4.45% faster** than
Windows's high-resolution timer. Raw Linux hardware time closely matched
Windows in that probe. We also observed a wall-clock step during an otherwise
steady monotonic interval. The methods retain the measured samples and
read-only kernel clock state.

Lean's [runtime timer](https://github.com/leanprover/lean4/blob/470d5ce1400764999581fd26d5d72b00d990b0f4/src/runtime/io.cpp)
uses a steady clock; the pinned Linux binary calls `CLOCK_MONOTONIC`.
Linux [documents](https://man7.org/linux/man-pages/man2/clock_gettime.2.html)
that this clock is subject to frequency adjustment, while the raw hardware
clock is not. Original timings remain unrescaled. This observation cannot
retrospectively calibrate the earlier captures or establish an error bound
for either whole corpus. A uniform clock factor cancels in cost shares and
paired overhead ratios; it does affect absolute reported milliseconds.
Instruction counts do not depend on this elapsed-time scale.

## Interpreting agreement and trustworthiness

Source-attributed time, instrumented frontend time, CPU instructions, and
native compilation wall time measure different quantities. Native compilation
includes output serialization and code generation; the frontend stopwatch
ends before those stages and trace export. Hosted timings come from different
hardware and scheduling. Mathlib's source/native hardware fingerprints are
recorded in the methods. The earlier LeanPool capture has no independent
CPU/kernel fingerprint, so hardware identity with its new native run cannot
be verified.

The local Mathlib compiler command resolves through Elan, so its launcher is
inside the measured process. The source frontend stopwatch starts after
profiling-driver startup. Lakeprof reads module wall durations from Lake's
printed output, which rounds the values to display precision.

Rank correlation describes whether expensive files appear in a similar order.
Share distance is half the sum of absolute differences between normalized
cost shares. A distance of 10% means the two cost distributions allocate 10%
of their mass differently; it is **not a 10% timing error estimate**.
Aggregating costs can improve agreement while hiding file-level differences.

[Measured LeanPool repeatability](REPEATABILITY.md) is a separate experiment:
five files, five measured recaptures after warm-up. Median pairwise differences
were 1.85% for file source time and 1.81% for frontend time; the corresponding
95th percentiles were 11.50% and 8.30%. Declaration and line attribution showed
larger relative variation. Those results do not promise that every file or
line, or a repeat of the entire pool, will stay within 10%.

Profiling-only heartbeat allowances are disclosed per file, after native
compilation under the original options succeeded. Native Radar runs use the
original options. Timing bars are useful for locating costs; validate small
optimization gains with controlled uninstrumented runs or work counters.

## Datasets and evidence

- [Mathlib source explorer and provenance](MATHLIB-SOURCE.md).
- [Original LeanPool profile and provenance](WHOLE-POOL.md).
- [Complete comparison manifest](compare/manifest.json).
- [Methods, source audits, code hashes, hardware evidence, instruction control, and paired frontend results](compare/methods.json).
- [Hosted Mathlib comparison rows and statistics](compare/data/mathlib-hosted.json.gz).
- [Local Mathlib comparison rows and statistics](compare/data/mathlib-local.json.gz).
- [Local LeanPool comparison rows and statistics](compare/data/leanpool-local.json.gz).

The manifest binds the compressed datasets and methods with SHA-256 hashes.
Source explorer manifests provide the pinned source hashes. Full browser
validation checks the actual inventories, displayed points, aggregate totals,
source and line links, and mobile layout before publication.
