# Project profiling validation — 0.2.0

Validated 2026-09-27 on macOS arm64, VS Code 1.138.0, Lean 4.34.0-rc2.

## Automated results

- **48 unit/CLI/viewer tests passed**, with no failures or skips. These cover the existing interval accounting, source overlays, process handling and malformed inputs, plus query filters/rankings, nested/shared declaration ownership, aggregate contributing roots, folder accounting, local viewer routes, hostile inputs, JSON/JSONL output, and SIGTERM cancellation of the CLI and its detached capture child.
- **12 collection integration checks passed** using real Lean and controlled failure cases: discovery/exclusions, deterministic paths, actual multi-file capture/indexing, old-format loading, individual failure continuation, cancellation checkpoints, no-overwrite behavior, manifest/index validation, symlink escapes, and index-ahead-of-manifest recovery.
- **29 portable capture regression checks passed**: independent exact syntax positions, Unicode, multiline/repeated/nested tactics, source snapshots, imported references, interval accounting, errors, heartbeat rejection and cancellation.
- Semantic declaration contract checks passed for eight exact theorem names/ranges, private names, declaration kinds and generated-helper classification. Asynchronous body and worker scopes remain present with a 50 ms internal trace threshold.
- **17 real VS Code integration categories passed**, both from the development checkout and the installed VSIX: current-file capture, saved profiles, source timing annotations, source selection, imported navigation, stale/restored source behavior, toggles, new command registration, a fresh two-file session, switching into a nested file, snapshot fidelity, isolation of overlays between files, and reopening a legacy single-file recording.

## NS attribution

The original OAI and LeanPool `meanField_add'` files were captured with the updated driver. Both exported the exact semantic declaration name and full source range. The index correctly assigned the final `exact` to that declaration while keeping `funext` separate. The OAI declaration's recorded interval union was about 2.90 s while its command dispatcher took about 11.9 ms, demonstrating that the new declaration query includes asynchronous proof work rather than returning the dispatcher alone. These were attribution checks at different internal trace thresholds, not a controlled speed comparison.

## Browser review

A real two-file session was opened in Chrome. The repository tree showed the selected folder, a nested folder and a file, with descendant totals of approximately 394 ms and 380 ms (50.9% and 49.1%). Folder and repository percentage denominators were explicit. The captured scope is displayed separately from the project name.

The declaration ranking opened the saved source with timing bars. A 2.0 ms declaration aggregate showed all four contributing operation roots, including asynchronous roots, and retained its 2.0 ms union total. Selecting an individual root exposed its actual nested operations and self time. This fixed an initial UI mismatch where opening only the representative dispatcher showed 1.2 ms instead of the aggregate cost. Source bar selection and breadcrumb navigation were also exercised.

The stable demonstration recording is generated at `test/results/project-session/session.json`; its source fixtures live under `test/fixtures/CollectionSource`. Test outputs remain under the ignored `test/results` directory.

## Release behavior and limits

- Folder/project files run sequentially with prebuilt imports. This is an isolated-file profiling session, not a Lake build dependency timeline. Imports may be loaded repeatedly; file and folder totals include them.
- Declaration/tactic timings are inclusive recorded interval unions. Nested declarations and shared command ranges overlap; they are labeled accordingly. Tactic `selfMs` describes its representative event, while `eventIds` preserves contributing scopes.
- Failures and cancellation remain visible in the manifest and machine-readable query metadata. Completed files survive cancellation. New captures require a fresh output directory.
- Recordings remain local. The standalone viewer binds to loopback and reads only validated session artifacts/snapshots. VS Code's existing source freshness guards remain in use.
- Capture remains validated only on Lean 4.34.0-rc2. Existing version-1 recordings work, but older recordings need recapture to add semantic declaration metadata.

See `PROJECT-PROFILING-PLAN.md` for the design and `SESSION-FORMAT.md` for the schema, metric definitions, commands, and direct JSONL examples.
