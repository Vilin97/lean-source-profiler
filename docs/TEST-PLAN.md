# Source profiler acceptance and regression tests

## Test environments

Baseline toolchain: Lean 4.34.0-rc2 on macOS arm64. Standalone fixtures are in
`test/fixtures`, with no network package dependencies. NS captures use the
already built OAI and LeanPool projects, both pinned to the same Lean version.

Available local VS Code: 1.138.0 (arm64), `/opt/homebrew/bin/code`, with
`leanprover.lean4` version 0.0.240 installed. VS Code extension integration tests
can launch the installed application with `--extensionDevelopmentPath` and
`--extensionTestsPath`; use a fresh temporary user-data directory and fixture
workspace so tests cannot change the user's open project or settings. Package
installation is a separate check in another temporary user-data/extensions
directory using `code --install-extension <vsix> --force`.

## Accuracy: source locations

`test/fixtures/expected-ranges.json` is the static coordinate oracle. Do not
derive expected locations with the same parser/conversion functions that the
profiler uses. Assert locations by slicing source with VS Code's UTF-16 range
semantics and comparing both coordinates and exact source text.

| Fixture | Required evidence |
| --- | --- |
| `twoTactics` | Separate source associations for `funext n` and `exact Nat.add_zero (f n)`; times are attached to the corresponding tactic. |
| `repeatedTactics` | The two identical `exact True.intro` statements have distinct ranges and IDs. No source lookup by first text match. |
| `multilineTactic` | One `exact` spans lines 19–22 in the editor. Details preserve its full range; the UI does not imply separate measured times for its continuation lines. |
| `unicodeColumns` | The tactic begins at UTF-16 position (26,13), not a UTF-8 byte column or codepoint column. Hover/click selects precisely the tactic after the emoji comment. |
| `nestedTactics` | The `have` contains its inner `exact`, while the subsequent `exact h` is a sibling. Inclusive durations are not added twice. |
| `importedReduction` | The caller owns its elapsed cost. A reference to `importedAdd` resolves to the separate `Imported.lean` source. |
| `reductionWork` | Capture contains definitional equality/reduction work associated with the calling `exact`; drill-down remains attached to that source operation. |
| `importedProof` | Following `importedAdd_zero` opens its declaration. The UI does not imply that the imported proof was elaborated again. |

## Accuracy: timing and trace integrity

1. Every event has a finite, nonnegative duration and a valid ID. Parent IDs
   resolve; the graph is acyclic; all source ranges are ordered and in bounds.
2. When traces have timestamps, a child's interval lies within its parent's
   interval (allow only documented clock/rounding tolerance). If execution
   overlaps, self time subtracts the union of child intervals, not a naive sum.
3. A selected tactic's displayed inclusive time equals the backend's measured
   inclusive time. Displayed self time has an explicit definition. Do not sum
   ancestors and descendants into a file total or hide threshold omissions.
4. The source of costs is explicit: elaboration time, trace wall time, or CPU
   samples are not interchangeable. Capture wall clock may include imports
   and serialization absent from tactic bars.
5. A nonzero threshold may omit small trace children. Their omission must not
   be described as proof that the parent's residual time was spent directly
   in that function.
6. A local proof site's duration includes reduction of imported definitions.
   A referenced declaration alone is not sufficient evidence for allocating
   time to that declaration. Show contextual costs only when an actual trace
   records the declaration being visited. Otherwise show a navigation link
   clearly labelled as a reference.

## NS acceptance: `meanField_add`

Capture `test/fixtures/ns/OaiMeanField.lean` in the OAI environment and
`LeanPoolMeanField.lean` in the LeanPool environment. Both include `original`
and `explicit` theorem variants. Preserve original theorem text in the user
projects; the fixture namespace keeps the tests isolated.

- Compilation succeeds with the same toolchain; no `sorry` or admitted proof
  is introduced by capture instrumentation.
- The original proof has two distinct tactic source ranges: `funext w` and
  multiline `exact congrFun ...`. Most OAI proof cost is attributable to
  `exact`; the UI's larger bar is on that statement.
- Expanding OAI's `exact` shows internal `Meta.isDefEq`/`Meta.whnf` work when
  traced; the label includes useful expression details rather than only a
  repeated category name.
- The explicit variant additionally has its own `dsimp only` range. Repeated
  `exact congrFun` text in the same fixture is attributed to the correct
  theorem.
- Compare uninstrumented compilation with instrumented compilation and report
  capture overhead. Do not promise a fixed timing ratio: system load and
  tracing affect elapsed time. Record the observed original/explicit and
  OAI/LeanPool relationships rather than asserting an arbitrary strict ratio.
- Cross-file links open actual definitions in the appropriate variant's
  project, retaining which recording/call supplied the context.

## Automated extension-host integration

Expose or test public commands; do not drive private UI state exclusively.

1. Activate extension in a Lean workspace; verify profile/open/clear commands
   register and contributed buttons exist.
2. Execute profile command on the saved active fixture; wait for successful
   process exit and complete profile output. Verify status transitions and
   that no source file changed.
3. Open saved profile; check decorations/range models against the oracle,
   CodeLens/actions, and child item labels/durations.
4. Select a tactic through its public command; verify source selection and
   details. Navigate a referenced imported declaration; verify the editor URI
   and range match `Imported.lean`.
5. Edit the document after capture. Mark profile stale and disable or
   prominently flag timing attribution. Undo to original bytes; restore
   attribution after the document is saved/revalidated.
6. Close and reopen VS Code with the saved profile; reload without recompiling.
7. Clear the profile; remove all decorations, lenses, details and stale status.
8. Start profiling and cancel promptly. Ensure the process tree ends, no
   partial file is accepted as complete, and another profile can run.
9. Attempt a second capture while one is active. Prevent overlap or explicitly
   cancel the first without mixing files, traces or progress notifications.

## Negative and security cases

- No Lean/Lake executable: concise actionable error; no spinner left running.
- Unsupported toolchain/backend API: identify version and supported baseline;
  no silently empty successful profile.
- A source syntax or elaboration error: diagnostic and unsuccessful capture,
  without overwriting a previous valid profile with partial data.
- Malformed JSON, unknown schema, missing required fields, negative/NaN times,
  cycles and invalid ranges: reject with a clear message.
- Legacy Firefox profile without source metadata: do not guess locations or
  silently map expression strings to the wrong repeated tactic.
- Mismatched file content, missing source, moved workspace and file outside
  the project: show the appropriate unresolved/stale state; never open a
  fabricated location.
- Profile-provided HTML/Markdown-like strings are escaped in the sidebar.
  Navigation commands accept only expected IDs/locations; profile contents
  never cause shell execution or arbitrary command links.
- Paths containing spaces and quotes work through structured process args.
- Untrusted workspaces cannot execute Lean via a profile button until trusted.
- Profiling unsaved content is an explicit action with clear handling; do not
  silently save unrelated dirty documents.

## UI visual inspection and installation

After automated tests, inspect the packaged extension in VS Code, not only the
development host. Test light/dark themes, narrow editor/sidebar, long tactic
labels, keyboard navigation, and readable source text under decorations. Bars
should communicate their scale and measured unit. The selected call should
stay obvious while navigating definitions in another editor.

Capture screenshots of the OAI original `meanField_add` bars, its expanded
`exact` breakdown, a cross-file navigation result, and stale-source state.
Check the VSIX contains the driver and compiled runtime but excludes large
NS projects, build artifacts, temporary captures and secrets. Install the VSIX
using the documented one-command install, open a fresh window, and reproduce
the documented profile/open workflow before shipping.

## Results recorded so far

- 2026-09-23: `lake build` for the standalone fixture project passed (5 jobs).
- 2026-09-23: both NS fixture files compiled successfully in their respective
  existing OAI and LeanPool Lake environments with Lean 4.34.0-rc2.
- 2026-09-23: a baseline Lean trace capture of `Accuracy.lean` at threshold 0
  completed. Its exported labels contain 589 `Meta.isDefEq`, 245 `Meta.whnf`,
  29 `importedAdd`, and 419 `transparentIteration` occurrences, confirming the
  fixture exercises the intended internals (counts are observations, not stable
  regression assertions).
- 2026-09-23: `node test/capture.integration.cjs` passed **47 checks**, including
  all 12 static location oracles, duplicate/multiline/Unicode/nested attribution,
  cross-file references and explicit unfolding markers, independent timing
  accounting, inherited-source ancestry, saved-recording roundtrip, 5 tactic
  ranges in each NS variant, failed elaboration output preservation, malformed
  JSON rejection, and cancellation. See `test/results/accuracy.json`.
- All three recordings report Lean **4.34.0-rc2**. The NS original `exact` took
  **3463.77 ms** (OAI) and **18.37 ms** (LeanPool); the explicit reduction variant's
  `exact` took **1.12 ms** and **1.54 ms**, respectively. These are observed trace
  times from one run, not stable performance guarantees. OAI had 19,209 events;
  LeanPool had 431 at the 1 ms internal threshold.
- Capture wall time including driver execution and export was **51.62 s** for
  OAI and **9.90 s** for LeanPool, versus **7.47 s** and **6.29 s** for direct
  uninstrumented compilation. Export overhead is material and separate from
  the reported operation times. Portable fixture capture took **3.42 s**.
- All owned temporary NS source directories and negative-test source files
  were removed after the test run. Original user source files were not edited.
- After fixing header-error handling, the portable suite was rerun with
  `node test/capture.integration.cjs --skip-ns`: **29 checks passed**. New
  regression checks confirm a missing import rejects capture, heartbeat-based
  traces are rejected instead of mislabeled as milliseconds, and both errors
  preserve an existing output recording. This run is recorded separately in
  `test/results/accuracy-portable.json`, retaining the full NS run above.
- `node test/stale-import.integration.cjs` passed **17 checks** through the
  final capture API. A newly built imported definition mapped to editor line 2;
  shifting its source by two lines without rebuilding set `sourceStale` and
  suppressed all outdated declaration ranges; rebuilding restored the correct
  line 4; restoring the original source and rebuilding restored line 2.
  Semantic references and the declaration file survived each stage. The test
  checks modification times to ensure the stale branch actually runs, and
  removes its unique source module and compiled artifacts afterward. Evidence:
  `test/results/stale-import.json`.
- Extension-host, visual UI, and packaged-install results are recorded by the
  corresponding runners and release report.
