# Source-focused capture

The default `compact` mode measures the current module's source scopes without collecting
every internal `Meta` operation beneath them. It retains nested canonical term and tactic
syntax, semantic declaration names/ranges, thread IDs, and completed asynchronous
declaration scopes. Generated syntax without a canonical location remains inside the
enclosing scope's inclusive time. It does not fabricate timings for missing source ranges.
Elaborators registered by commands within the profiled file are not individually wrapped;
their work remains in enclosing retained scopes and the completed frontend total.

`detailed` mode retains the internal trace and formats expressions, references and unfolding
evidence. It can cost substantially more. Both modes use the project's installed compiler,
load built imports, and wait for the asynchronous kernel environment before stopping the
frontend timer. Failed elaboration or kernel checking cannot publish a successful recording.
Neither mode edits the profiled source, installed toolchain, project options or quality gates.

```sh
lean-profile profile MyLibrary --output /tmp/source-profile
lean-profile profile MyFile.lean --mode detailed
```

Set `leanSourceProfiler.captureMode` to `compact` or `detailed` in VS Code. Timing bars,
declaration/tactic queries, saved source snapshots and the standalone viewer work in either mode.
Compact mode has no expression text or imported-definition links.

## Configuration and execution

The driver uses the module's existing `.lake/build/ir/<Module>.setup.json` when available,
including its options, package, module visibility, import artifacts, plugins and dynamic
libraries. Build the module's imports and prepare a current Lake setup before measuring a
configured library. Compact recordings include the setup mode and option values. Without
a setup, the driver uses plain Lean options, like `lake env lean File.lean`; this is not a
claim to have reproduced package-specific build options. Custom source/build directories
are not yet resolved automatically.

Command-line defaults for asynchronous elaboration, minimal command snapshots, import
trust and persistent imported environments match the native Lean shell. The driver still
checks new declarations through the kernel. Source-level `set_option`s apply normally;
heartbeat-valued tracing is rejected rather than mixed with wall-clock intervals.

The native driver is compiled with `leanc -O3` and Lean's shared runtime. Interpreter support
keeps imported metaprogram externs available. The content-addressed cache includes the
driver, clock helper, compiler Git hash, toolchain prefix, platform and architecture; cached
binaries are checked against SHA-256 receipts. Incomplete/corrupt builds are rebuilt, and
cancellation terminates compiler/frontend children. Lake's environment is discovered once
per unchanged project configuration in a session. Timed file frontends run sequentially.

Each successful file appends its query rows before the manifest checkpoint is committed.
The whole growing index is no longer rewritten after every file. Readers restrict rows to
committed successful files and recompute folder totals. An incomplete trailing append in
an unfinished session is recoverable; a malformed completed row is an error. An append
failure is rolled back before another file is attempted.

## Clocks and attribution

On Linux x64/arm64, compact source timers read `CLOCK_MONOTONIC_RAW` directly. Lean's built-in
command/async/body timers still use its monotonic counter; the native driver samples both
clocks at the start, after imports and at frontend completion, then maps those built-in
timers to raw elapsed time with separate import/source calibration segments. Source
timers do not use that interpolation. The recording stores `sourceClock`, the raw origin
and `clockCalibration`. No runtime clock function is replaced, and existing public datasets
are not rescaled. Other hosts, and direct interpreted captures, use Lean's clock.

Frontend elapsed time and compact source intervals have directly observed raw endpoints
on Linux. Built-in interval calibration assumes a stable rate within each segment; sudden
rate changes can distort those intervals. Calibration points make that assumption auditable.
Detailed mode calibrates all its trace intervals. Clock handling does not remove
scheduling noise, pauses or profiler instrumentation cost. It does not establish a universal
rerun error percentage or validate a machine's hardware oscillator independently.

`captureWallMs` includes driver preparation, frontend execution, decoding, snapshots,
serialization and the large recording write. Its small metadata patch, atomic rename and
temporary-directory cleanup follow that boundary. On Linux its host monotonic duration
uses the capture's observed average raw/monotonic rate. The benchmark below measures the
entire capture call and query-index write with an independent raw stopwatch, including
those final steps. One-time preparation is reported separately from warm captures.
The stored capture total is a calibrated estimate: a rate change during preparation or
export can affect it. `exportPreparationMs` uses Lean's counter, and session `wallMs` uses
the host counter. The benchmark's independent raw totals support performance claims;
these ancillary phase counters do not establish independent clock accuracy.

Declaration and tactic totals are unions of retained source intervals, not the sum of
nested nodes. They include the represented asynchronous scopes, but do not invent timings
for untraced gaps. Self time means inclusive time minus the union of recorded children;
it includes any internal work omitted by compact mode. Import/parser costs belong to the
file/frontend timer. These are elapsed measurements, not CPU-time or heartbeat counters.

## Validation

`test/compact.integration.cjs` feeds two independent exporters the same execution, then
requires identical event intervals, nesting, threads, source ranges, semantic declarations,
self times and query rows. It also checks independently specified Unicode/macro/nested
tactic ranges, every fixture theorem's asynchronous and sub-threshold body scopes, clock
boundaries, and compact save/read parity. Detailed capture keeps its existing expression
and imported-symbol regression checks. A deliberately invalid declaration supplied directly
by an elaborator must fail in the kernel and leave the previous recording untouched.
`test/setup.integration.cjs` requires native/configured option parity, explicit async=false,
clock-unit rejection, and kernel rejection in both modes. On Linux,
`test/raw-clock.integration.cjs` runs an independent Python raw stopwatch inside an imported
tactic and requires its endpoints to lie within that tactic's raw source interval.

Unit and collection checks cover corrupt compact tables, compiler-cache recovery,
cancellation, source snapshots, path safety, committed index visibility and interrupted
index appends. The native path is tested on Linux x64; macOS/Windows native compilation and
clock behavior require additional platform validation.

Build the [fixture imports](../test/fixtures/README.md) first, then run:

```sh
npm run check
npm test
npm run test:source-focused
node test/capture.integration.cjs --skip-ns
node test/collection.integration.cjs
node test/stale-import.integration.cjs
node test/declarations.capture.cjs
```

With Playwright available, `node test/compact.browser.cjs URL` checks folder, declaration,
tactic and source-bar navigation against a viewer serving the two source fixtures. Set
`PLAYWRIGHT_MODULE` and `BROWSER_CHANNEL` when using an existing browser/runtime installation.

## Reproducing the performance measurement

Build once with `npm ci && npm run build`. Supply a JSON array of absolute paths:

```json
[{"project":"/repo", "file":"/repo/MyLibrary/File.lean", "setup":"/repo/.lake/build/ir/MyLibrary/File.setup.json"}]
```

```sh
python3 scripts/benchmark-capture.py plan.json results.json 4
```

Each file gets one discarded warmup per mode and four measured repeats, with rotating
execution order. `native` invokes uninstrumented `lean --setup` without writing compiler
artifacts. `baseline` uses the same compiled driver/frontend with source instrumentation
and added tracing disabled. `compact` includes the capture API, decoding, atomic saved
recording publication, query generation and an index write. All use the same built imports
and setup. Source and setup hashes must remain unchanged. Driver and clock-helper SHAs
are pinned across the run; every measurement is sequential. Cold driver/environment preparation is reported
separately and must be included when estimating a short first session.

All modes include the same long-lived host's request/control and warm backend validation.
The compact mode additionally runs the capture API's own validation. This measures file
capture plus its query-index export; it does not include dependency builds or a growing
session's manifest checkpoints/final folder aggregation. It is a selected-file benchmark,
not a rerun of the entire Mathlib or LeanPool corpus.

## Measured results: 3 October 2026

Linux x64 under WSL, AMD Ryzen 9 9955HX. Mathlib was pinned to
`726a7f1e86c481739c97cb90f5acb25f311f5ec8` with Lean 4.35.0-rc3; LeanPool to
`38b8ba36899903cb7d3a42bb9f8a3f5c70fdb05f` with Lean 4.34.0. Each mode has four
measured repeats and one discarded warmup per file: 288 measurements and 72 warmups.
The audit verified exact coverage, unchanged source/setup hashes and frozen implementation
hashes. [All measurements and provenance](benchmarks/2026-10-03-linux-compact.json),
[per-file medians](benchmarks/2026-10-03-linux-compact.csv).
Setup hashes audit continuity during this run; their local artifact paths can differ in
another checkout.

| Selected files | Native sequential time | Compact capture + index | Overhead |
|---|---:|---:|---:|
| Mathlib: 21 | 114.888 s | 118.397 s | 3.05% |
| LeanPool: 3 | 5.364 s | 5.474 s | 2.04% |
| Combined: 24 | 120.252 s | 123.870 s | **3.01%** |

The table divides sums of per-file medians. The four complete-repeat overheads range from
2.81% to 3.22%. Median per-file overhead is 2.59%; nearest-rank p95 is 9.12%, and the
maximum is 10.74%. Negative differences in some files are sampling variation, not evidence
that tracing makes Lean faster. The raw frontend comparison against the same-driver baseline
shows 2.52% aggregate instrumentation overhead; capture/index export contributes to the
larger end-to-end figure.

First-use compilation and environment discovery cost another 11.43 s for Lean 4.35.0-rc3
and 15.60 s for Lean 4.34.0. These costs are outside the warm table and can dominate a short
first session. These results support low overhead on the selected files, not zero cost or
a universal rerun error percentage. Full internal/expression tracing remains expensive.
