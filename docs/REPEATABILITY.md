# LeanPool timing repeatability sample

On October 1, 2026, five unchanged LeanPool files were captured six times each:
one warm-up followed by five measured captures. The source, native Lake setup,
and profiler-driver hashes matched the original whole-pool recording. The
experiment used the same 1 ms internal-operation threshold and source-time
allocation. Captures ran sequentially on the same WSL machine with prebuilt
imports and no deliberate parallel Lean workload.

The files were selected for manageable capture sizes across five projects.
They are a convenience sample of short and medium captures, not a random
sample of the entire pool or its most expensive proofs.

| Measurement | Groups | Median difference between runs | 95th percentile | Maximum |
|---|---:|---:|---:|---:|
| File source-attributed time | 5 | 1.85% | 11.50% | 13.51% |
| File frontend time, including imports | 5 | 1.81% | 8.30% | 9.57% |
| Declaration source-attributed time | 27 | 2.36% | 17.69% | 27.67% |
| Source-line anchor time | 23 | 2.50% | 14.15% | 35.72% |

Each group contributes all ten pairs among its five measured runs. Difference
is `100 * abs(a - b) / ((a + b) / 2)`. The percentiles describe these observed
pairs; they are not confidence bounds. Declarations and line anchors enter
the table only when their median attributed time is at least 50 ms.

File source-time coefficients of variation (sample standard deviation divided
by mean) ranged from **1.20% to 5.89%**. Comparing the new file medians with their
original September 28–30 recordings gave differences from **−0.37% to +12.36%**.
Those comparisons span different operating conditions and are not additional
controlled replicates.

## Interpretation

This sample supports using the profile to locate substantial costs. Most
observed repeat differences were a few percent, but a blanket promise that
every value will repeat within 10% is unsupported. Small source locations and
concurrent work can have larger relative variation. Timings below 50 ms were
not assessed by the declaration/line table.

Repeatability also differs from accuracy against uninstrumented compilation.
The profiler adds overhead, and its allocation splits simultaneous source
scopes equally across active threads before assigning each share to the
deepest source anchor. These are attributed wall times, not independent CPU
timers for individual lines. The experiment does not measure instrumentation
overhead or establish an error bound for a repeat of all 7,060 files.

Use ordinary uninstrumented runs or deterministic work counters to validate
small optimization gains. For the competition package, the separate native
heartbeat remeasurements reproduced all ten selected counts exactly; these
are different measurements from the explorer's wall-time bars.

## Evidence

- [Machine-readable analysis](repeatability/report.json).
- [All warm-up and measured runs](repeatability/runs.json.gz).
- [Timing definitions and original capture provenance](WHOLE-POOL.md).

The files are `IntersectionStep.lean` (AndersonConjecture),
`GeneratedUniverse.lean` (InfinitaryLogic), `IncludeBlock.lean` (Monlib4),
`CorrectionEnergyScalar.lean` (NavierStokesAndEuler), and
`CoverageCertificateFacts29.lean` (Erdos97ConvexOctagon). Full paths and values
are recorded in the analysis JSON.
