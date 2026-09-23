# Release validation — 0.1.0

Tested 2026-09-23 on macOS arm64, VS Code 1.138.0, Lean 4.34.0-rc2.

## Automated checks

- TypeScript strict type checking passed.
- **26 unit tests passed**, covering interval-union accounting, recursive/deep traces, malformed/foreign recordings, Unicode positions, process argument escaping, cancellation, project detection, source bar grouping, structural wrapper exclusion, clickable bar scaling, stale-source suppression/restoration, navigation semantics, HTML escaping and webview CSP.
- **47 capture integration checks passed.** All 12 independent exact range oracles passed, including repeated tactic text, Unicode, multiline syntax and nested proofs. Both NS variants' original/reduced proofs passed source-span and event ancestry checks. Child intervals, independently calculated self times, semantic definition references and actual unfolding markers were checked.
- A subsequent **29-check portable regression run passed**, including missing-import and heartbeat-clock rejection. A missing-import failure discovered during review is fixed; failed captures preserve existing output.
- The real VS Code extension-host test passed capture, saved recording generation, source CodeLens, selecting the right tactic, imported-definition navigation, stale-buffer suppression, restoring source, toggle/clear, and reopening a recording without re-elaboration.
- The VSIX was installed into a separate extension directory and the same integration checks passed against that installed package, using its bundled JavaScript and Lean driver.
- **17 stale-import integration checks passed** through clean build → edit without rebuilding → rebuild → restore and rebuild. Edited-source links were disabled; rebuilding restored them at the correct shifted source location. Run `node test/stale-import.integration.cjs` to reproduce.

## NS findings

These timings are from instrumented runs used to validate attribution, not controlled performance benchmarks. Captures and a separate ordinary compile were run on the laptop during development.

| Proof statement | OAI | LeanPool |
|---|---:|---:|
| Original `meanField_add` final `exact` | 3463.77 ms | 18.37 ms |
| Final `exact` after explicit `dsimp only` reduction | 1.12 ms | 1.54 ms |
| Entire capture, including export | 51.62 s | 9.90 s |
| Ordinary compile of the same fixture | 7.47 s | 6.29 s |

The original expensive statement and explicit-reduction statement map to their own exact syntax spans. Sequence wrappers do not transfer the proof's cost to the first `funext` line. OAI's capture retained 19,209 events; LeanPool's retained 431. Profile export/pretty-printing overhead is substantial and separately reported in the UI.

## Native UI review

The editor-title Profile button successfully captured the user's original OAI `NavierStokes/test.lean`. The resulting details view showed separate `funext` and `exact` annotations (0.400 ms and 3.59 s in that run). Clicking the expensive statement selected both source lines and opened its nested costs and actual proof expression. A definition link opened `ActualMeanPhysicalData.lean` at `Atlas.physical_add`. These checks were observed in the real macOS VS Code UI.

The initial end-of-line bar could be clipped for long Lean statements. The release adds a proportional bar to the clickable timing CodeLens above the line, so the action and bar remain visible at the source start. Nested costs precede the definition list in the details view.

After reloading the final build, the saved OAI recording reopened successfully. Both proportional CodeLens bars were visually verified; clicking the bar above `funext` selected its eight-character invocation and displayed its own 0.400 ms breakdown. VS Code's automatic screen-reader mode initially hid CodeLens; matching the preview's accessibility setting to the user's normal setting restored it. The documented tree, statement list, and hover actions remain available when CodeLens is hidden.

## Limits

- Only Lean 4.34.0-rc2 is validated for capture. The driver uses internal Lean APIs.
- Macro expansions are attributed to their invocation ranges; newly registered local elaborators may have only enclosing attribution.
- An unfolding marker provides evidence of unfolding within a timed operation, not an exclusive timer for that definition. Cross-file purple annotations explicitly show caller context.
- Raw Firefox profiles lack the needed source mapping and must be recaptured.
- Imported source freshness uses modification times against compiled artifacts; newer/unverifiable locations are disabled until imports are rebuilt. It is not a cryptographic correspondence check.
- Detailed trace capture is for finding costs. Use independent uninstrumented runs for benchmark claims.

Raw reproducible results are generated under `test/results/accuracy.json`, `test/results/extension-host.json`, and `test/results/stale-import.json`; the test fixtures and runners are versioned in this repository.
