# Mathlib Radar flame explorer

[Open the explorer](https://vilin97.github.io/lean-source-profiler/mathlib/).

This view uses the same flame explorer as the whole LeanPool profile, with an
adapter for [Radar's public Mathlib benchmarks](https://radar.lean-lang.org/repos/mathlib4).
It descends from Mathlib through its folders to individual files. Switch the
width between **CPU instructions** and **source line count**.

The snapshot covers **8,556 files**: every **8,555** `.lean` file under `Mathlib/`
and the root `Mathlib.lean`. Each has both measurements. The exporter verified
the file set against the complete Git tree at the measured commit, with no
missing or unknown files. Dependency files such as Aesop and Batteries are
excluded, as are separate whole-build aggregate measurements.

The sum is **130,279,453,598,200 CPU instructions** and **2,343,682 source lines**.
Line counts use Radar's definition. Each selected file links to its source at
the exact measured Mathlib commit.

## Measurements and limits

CPU instruction counts measure file compilation with hardware performance
counters. They are distinct from Lean heartbeats and from our source-attributed
wall times. The folder hierarchy groups files; it is not a compiler call stack
or a build dependency timeline. Summing these file counts also differs from
Radar's separate whole-build measurements, which include additional work.

Radar provides no declaration or source-line measurements in this snapshot.
The viewer stops at the file and states that limit explicitly. Source line
count is a size metric; it is not a timing for each line. A full source-level
Mathlib explorer would require a separate capture.

## Provenance

- Mathlib commit: [`726a7f1e86c481739c97cb90f5acb25f311f5ec8`](https://github.com/leanprover-community/mathlib4/tree/726a7f1e86c481739c97cb90f5acb25f311f5ec8).
- Lean toolchain: **4.35.0-rc3**.
- [Original Radar run](https://radar.lean-lang.org/repos/mathlib4/commits/726a7f1e86c481739c97cb90f5acb25f311f5ec8):
  `main`, runner `runner-mathlib1`, completed successfully.
- [Benchmark wrapper](https://github.com/leanprover/radar-bench-mathlib4/blob/master/bench.sh)
  delegates to Mathlib's
  [build benchmark](https://github.com/leanprover-community/mathlib4/blob/726a7f1e86c481739c97cb90f5acb25f311f5ec8/scripts/bench/build/run).
- [Dataset manifest](mathlib/manifest.json), [coverage](mathlib/coverage.json),
  and [original measurements](mathlib/data/radar-measurements.json.gz).

The data is a pinned snapshot, not a live mirror. Loading the viewer makes no
requests to Radar. File-level values retain the exact values from the API.

## Reproduce the export

Save the following inputs into a directory, preserving the names:

- `latest-commit.json`: Radar's `/api/commits/mathlib4/<commit>/`.
- `measurements.json`: Radar's `/api/compare/mathlib4/<commit>/<commit>/`.
- `source-tree.json`: GitHub's complete recursive Git tree for that commit.
- `lean-toolchain`: Mathlib's file at the same commit.

Then run:

```sh
python3 scripts/export-radar.py /path/to/inputs docs/mathlib
```

The exporter rejects incomplete or mismatched coverage, unsuccessful runs,
missing metrics, and duplicate metrics. The viewer shares `docs/pool/app.js`
and `docs/pool/style.css` with the LeanPool explorer.
