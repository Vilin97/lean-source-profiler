# Source attribution fixtures

This is a self-contained Lake project pinned to Lean **4.34.0-rc2**, with no
Mathlib dependency. `SourceProfileFixtures/Accuracy.lean` and `Imported.lean`
are small enough to audit against their expected locations by hand.

```sh
cd test/fixtures
lake build
lake env lean -j1 SourceProfileFixtures/Accuracy.lean
```

`expected-ranges.json` is a static oracle: positions use zero-based lines and
UTF-16 columns, with exclusive ends. It also records UTF-8 byte offsets so a
failure can distinguish a source-range mistake from a coordinate conversion
mistake. In particular, `unicode-utf16` starts at line 26, character 13, despite
the emoji before it occupying four UTF-8 bytes and two UTF-16 code units.

The two NS fixtures intentionally are not part of this project's default build.
Run them inside the existing benchmark's Lake environments:

```sh
cd /Users/vasil/Github/ns-formalization-benchmark/oai
lake env lean -j1 \
  --root=/Users/vasil/Github/lean-source-profiler/test/fixtures/ns \
  /Users/vasil/Github/lean-source-profiler/test/fixtures/ns/OaiMeanField.lean

cd /Users/vasil/Github/ns-formalization-benchmark/leanpool
lake env lean -j1 \
  --root=/Users/vasil/Github/lean-source-profiler/test/fixtures/ns \
  /Users/vasil/Github/lean-source-profiler/test/fixtures/ns/LeanPoolMeanField.lean
```

Each NS fixture contains the original `meanField_add` proof and the proof with
explicit `dsimp only`. These copies give a stable comparison without modifying
the user's original Lean files. Their expected result is successful compilation;
their timing difference is measured separately by the source profiler.
