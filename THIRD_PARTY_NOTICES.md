# Third-party notices

Lean Source Profiler's original implementation is distributed under the
[MIT license](LICENSE). The two Navier–Stokes test fixtures listed below contain
adapted upstream proof snippets distributed under the **Apache License,
Version 2.0**. Their upstream license is preserved in
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt); the repository's MIT license does
not replace it.

## Navier–Stokes accuracy fixtures

### `test/fixtures/ns/OaiMeanField.lean`

Adapted from `meanField_add` in OpenAI's
[`NavierStokes/ActualCandidateConstruction.lean`](https://github.com/openai/NavierStokesAndEuler/blob/8937a8f4cbc7abaab5e9e97d1cc7f5d2319d9538/NavierStokes/ActualCandidateConstruction.lean),
commit `8937a8f4cbc7abaab5e9e97d1cc7f5d2319d9538` of
[`openai/NavierStokesAndEuler`](https://github.com/openai/NavierStokesAndEuler).
The upstream repository provides the
[Apache 2.0 license](https://github.com/openai/NavierStokesAndEuler/blob/8937a8f4cbc7abaab5e9e97d1cc7f5d2319d9538/LICENSE).

### `test/fixtures/ns/LeanPoolMeanField.lean`

Adapted from `meanField_add` in
[`LeanPool/NavierStokesAndEuler/NavierStokes/ActualCandidateAssembly.lean`](https://github.com/Vilin97/lean-pool/blob/bb74ee07fc23bc81358d75a9c40303e5e27fced8/LeanPool/NavierStokesAndEuler/NavierStokes/ActualCandidateAssembly.lean),
commit `bb74ee07fc23bc81358d75a9c40303e5e27fced8` of
[`Vilin97/lean-pool`](https://github.com/Vilin97/lean-pool).
The source retains the following upstream notice:

```text
Copyright (c) 2026 OpenAI. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: OpenAI
```

The following relevant attribution is preserved from that revision's
[`NOTICE`](https://github.com/Vilin97/lean-pool/blob/bb74ee07fc23bc81358d75a9c40303e5e27fced8/NOTICE):

```text
Lean Pool
=========

Copyright the Lean Pool contributors and the respective project authors.

Lean Pool is licensed under the Apache License, Version 2.0. See the LICENSE
file for the full license text.

Projects originally licensed under the Apache License, Version 2.0

These projects were imported from repositories already licensed under the
Apache License, Version 2.0, and are redistributed here under the same license.

  LeanPool/NavierStokesAndEuler      https://github.com/openai/NavierStokesAndEuler
```

### Changes made for these tests

Lean Source Profiler contributors extracted the theorem into isolated fixture
files, adjusted imports and namespaces, renamed the theorem, reformatted its
arguments, and added a second version using explicit `dsimp only` reduction for
comparison. The fixtures depend on separately obtained upstream Lean projects;
those complete formalizations are not distributed in this repository.

The fixture files carry their notices after the proof text so the independent
source-position test oracles remain unchanged.
