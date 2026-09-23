# Lean Source Profiler delivery plan

## Outcome

A locally installable VSIX with **Profile Current Lean File** and **Open Profile** commands, editor toolbar buttons, source timing bars, clickable timing annotations, and a nested breakdown with source/definition navigation. A bundled terminal command produces the same recording without VS Code. The first tested toolchain is Lean 4.34.0-rc2, used by both NS snapshots.

## Capture and attribution

1. Run an isolated Lean frontend using the current project's Lake environment; never modify the user's source or installed toolchain.
2. Export a versioned flat event tree with parent IDs, timestamps, duration, source ranges, trace category, and rendered expressions. Keep tiny source-level events even when internal traces have a duration threshold.
3. Recover source ranges from structured Lean syntax information, not searches for printed tactic text. Use zero-based UTF-16 coordinates for VS Code. Internal operations inherit their nearest known source context and are labeled accordingly.
4. Resolve declaration references to source files. Separate references from actual unfolding evidence; a referenced name is not evidence of a cost.
5. Keep the source snapshot with the recording. Suppress overlays on changed files. Do not imply that unfolding an imported definition re-elaborates its original proof.

## Extension and CLI

1. Validate imported recording structure and recompute exclusive time from the union of child intervals. Avoid double-counting nested source events.
2. Display heat bars and clickable timing CodeLens on mapped source ranges. Clicking opens detailed time, expression, parent/children, and symbol links.
3. Provide a native profile tree, clear/toggle commands, progress, cancellation, and informative error handling. Capture requires workspace trust and saved files; viewing does not execute profile contents.
4. Support a CLI to capture a file into `.leanprofile.json` and open a saved recording with the installed extension.
5. Package the Lean driver and bundled JavaScript in a VSIX, with no compiler rebuild or separate npm install required for use.

## Accuracy tests

- Unit tests: inclusive/exclusive interval accounting, malformed records, cycles, repeated source ranges, unknown locations, profile validation, stale source behavior, process errors/cancellation.
- Lean fixtures: independent tactics, multiline tactics, repeated identical text, nested tactic sequences, Unicode before tactics, definitions imported from another file, compilation errors.
- NS: profile original and optimized `meanField_add`, plus wrapper-reduced probes and additional declarations. Confirm expensive work maps to the actual `exact` syntax range and that the explicit reduction reduces the expected event's cost. Compare with a baseline trace and report measurement overhead/limits.
- UI: run the real extension in VS Code, verify capture/open/overlay, source navigation, nested breakdown, stale suppression, and a packaged VSIX installation.

## Delivery

- Versioned VSIX and SHA-256 checksum.
- README with install, profile, visualize, and CLI commands.
- Test report with actual results, supported toolchain, attribution guarantees, limitations, and reproducible commands.
- Clean local Git repository containing source, tests, lockfile, packaging instructions, and plan.

## Release gates

No arbitrary source matching; no duplicate inclusive-time sums; no claim that references have measured reduction cost; no overlays on stale source; no silent capture failures; no unsupported one-click workflow claims. Any partially mapped events remain visible as unlocated/inherited operations.

## Implemented design

The capture stage uses a standalone Lean frontend with process-local wrappers around imported term/tactic elaborators. Structured syntax retained by these wrappers supplies exact ranges; internal traces inherit that context. No installed toolchain patch is required. Macro invocation ranges are preserved. Definition links distinguish references from actual, untimed unfolding markers; imported annotations show caller context rather than inventing per-definition costs. The release supplies clickable proportional timing CodeLens in addition to end-of-line decorations, a native event tree, and an expression/detail panel. Validation and residual limitations are recorded in `TEST-RESULTS.md`.
