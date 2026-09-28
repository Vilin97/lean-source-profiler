# Interactive LeanPool example

[Open the profile in your browser](https://vilin97.github.io/lean-source-profiler/examples/leanpool/).
No extension, Lean installation, or local server is needed.

[Jump directly to `meanField_add`'s `exact` tactic](https://vilin97.github.io/lean-source-profiler/examples/leanpool/#file=0&event=2356).
Its neighboring `funext` bar and the nested calls are clickable.

The viewer contains real recordings of selected Navier–Stokes modules from
[LeanPool](https://github.com/Vilin97/lean-pool/tree/bb74ee07fc23bc81358d75a9c40303e5e27fced8/LeanPool/NavierStokesAndEuler/NavierStokes).
Start in the folder tree, select a file, and click a bar beside the source to
inspect its nested operations. The declaration and tactic tabs rank the recorded
source groups. Links into imported definitions retain the selected caller's
context; they do not assign its elapsed time to every line of the definition.
For a separately captured target file, **Open this file's own profile** switches
to that recording's measurements.

## Provenance and measurement

- LeanPool revision: `bb74ee07fc23bc81358d75a9c40303e5e27fced8`.
- Lean: `4.34.0-rc2`; Mathlib revision:
  `85e3a25e006c35636f0e53b0e9296caca2685bc0`.
- The recorded LeanPool source files are unchanged from that revision. The local
  benchmark project updated the original Lean/Mathlib pins and narrowed the Lake
  build configuration to the NS dependency closure.
- Files are captured separately, sequentially, against prebuilt imports. Folder
  totals include repeated import loading. Detailed capture has overhead and the
  capture wall time includes trace export. These are not whole-repository build
  costs or uninstrumented benchmark results.
- The internal trace threshold is 10 ms for `ActualCandidateAssembly.lean` and
  1 ms for the other two files. Source-level scopes remain recorded at both
  settings. A smaller threshold retained too much internal detail for the
  viewer's 150 MB per-recording limit; the successful recapture is used here.
- Source paths are replaced with portable virtual paths. Source text, source
  ranges, event relationships, and timings are preserved. Local diagnostic logs
  and machine-specific editor links are omitted.
- Missing imported-definition locations are filled only by a unique exact
  file/name match in another captured declaration, with byte-identical source
  snapshots. This adds navigation without moving or inventing timing costs.
  The [navigation audit](examples/leanpool/data/navigation-provenance.json)
  records the method and counts.

The displayed scope and capture status identify which files have measurements.
Exact file hashes and capture details accompany the example in
[`provenance.json`](examples/leanpool/provenance.json). The
[`source-inventory.json`](examples/leanpool/data/source-inventory.json) lists the
included source snapshots and hashes.

## Query the same data

[Download the JSONL timing index](https://vilin97.github.io/lean-source-profiler/examples/leanpool/data/index.jsonl).
For example, find the most expensive recorded declaration:

```sh
curl -fsSL https://vilin97.github.io/lean-source-profiler/examples/leanpool/data/index.jsonl \
  | jq -s 'map(select(.kind == "declaration")) | max_by(.durationMs)'
```

The viewer also provides `data/session.json`, `data/index.json`, and individual
`data/files/<id>.json.gz` recordings (gzip-compressed JSON, with source and timings
unchanged). Declaration/tactic durations are unions of
recorded elapsed intervals; nested entries overlap. See the
[session format](SESSION-FORMAT.md) for metric definitions.

## Source licenses

The profiler is MIT-licensed. The three published LeanPool source snapshots
retain their upstream copyright notices and Apache 2.0 license. Mathlib,
Batteries, and Lean dependency versions are recorded in the provenance; their
source snapshots are omitted from this public example. See
the [third-party notices](../THIRD_PARTY_NOTICES.md) and
[Apache 2.0 license](../LICENSES/Apache-2.0.txt).
