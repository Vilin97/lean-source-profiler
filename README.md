# Lean Source Profiler

Profile a Lean file, folder, or project. Browse repository costs in a standalone viewer, overlay timings in VS Code, and query the slowest files, declarations, tactics, or folders.

The extension puts clickable timing bars above source statements, with a companion bar beside the code. A details view shows the expressions being compared, inclusive and self time, nested calls, source locations, and links to definitions in other Lean files.

## Install

Install the release `.vsix` using VS Code's **Extensions → … → Install from VSIX…**, or run:

```sh
code --install-extension dist/lean-source-profiler-0.2.0.vsix
```

The macOS release also includes **Install Lean Source Profiler.command** beside the VSIX; double-click it to install. No npm install, separate Node installation, or Lean rebuild is needed for the editor workflow. Lake/elan and already-built project imports are required.

**Tested with Lean 4.34.0-rc2 and VS Code 1.138.0 on macOS arm64.** The capture driver uses Lean internals, so other Lean versions may require adaptation. Viewing saved recordings does not require Lean.

## Profile and visualize

1. Open your Lean project and a saved `.lean` file. Build its imports first (`lake build` if necessary).
2. Click the **pulse** button in the editor title bar, or run **Lean Source Profiler: Profile Current File** from the Command Palette.
3. The recording is saved under the project's `.leanprofiles/` directory. Source bars and the details view open automatically.
4. Click **◷ … inclusive · inspect profile** above a statement. Follow its children to see `Meta.isDefEq`, `Meta.whnf`, and the expressions they operate on.
5. Click a definition link to open its source. Actual unfolding evidence is distinguished from an expression reference.

To visualize a previous capture without running Lean again, click the **folder** button or run **Lean Source Profiler: Open Profile**, then select a `.leanprofile.json` file. The **Lean Profile** activity-bar view also provides capture, open, toggle, and clear actions.

Editor decorations cannot receive ordinary clicks in VS Code: the clickable control is the timing CodeLens above the statement, or the **Inspect** action in the bar's hover. Multi-line tactics receive one annotation on their first line; selecting it highlights the complete recorded range.

If the bars above lines are missing, check **Editor: Code Lens**. We also observed hidden CodeLens in **Screen Reader Optimized** mode during UI testing. The **Lean Profile** tree, the details view's source-statement list, and the bar's hover action provide alternative navigation. The extension respects your accessibility settings.

## Folders and projects

Run **Lean Source Profiler: Profile Folder** or **Profile Project** from the Command Palette. You can also right-click a folder in Explorer and choose **Profile Folder**. Each successful file is saved in a session, with failures recorded and completed work retained when you cancel.

Open `session.json` with the existing folder button to browse the captured repository and select a file for source overlays. **Browse Session Sources** switches files. **Open Standalone Viewer** opens the same data in your browser: start with folder percentages, drill into files and source, or switch to ranked declarations and tactics.

The standalone viewer runs locally and loads individual traces as needed. File/folder percentages use the sum of isolated file processing times, including repeated import loading; capture wall time is shown separately. This is not a Lake build critical-path profile.

## Command line

From this repository, with Node.js 20 or newer:

```sh
node out/cli.js profile /absolute/path/to/Project/File.lean --output /tmp/file.leanprofile.json
node out/cli.js open /tmp/file.leanprofile.json

# Capture a folder or an entire project (imports must already be built).
node out/cli.js profile /absolute/path/to/Project/Subfolder --output /tmp/folder-session
node out/cli.js profile --project /absolute/path/to/Project --output /tmp/project-session

# The same session works in either viewer.
node out/cli.js view /tmp/project-session
node out/cli.js open /tmp/project-session

# Machine-readable rankings for agents.
node out/cli.js query /tmp/project-session --kind file --limit 1 --json
node out/cli.js query /tmp/project-session --kind declaration --limit 10 --json
node out/cli.js query /tmp/project-session --kind tactic --limit 10 --json
node out/cli.js query /tmp/project-session --kind folder --limit 10 --json
```

`profile` finds the Lake project automatically. Use `--list` to inspect discovered source files first. `open` invokes VS Code; `view` starts a loopback-only browser viewer until Ctrl-C. The same CLI is bundled at `out/cli.js` inside the installed extension directory. `npm link` in this repository optionally installs the shorter `lean-profile` command.

Sessions include `session.json`, per-file recordings, and `index.jsonl`. Queries read the compact index without loading every trace. See [session schema, accounting rules, and query examples](docs/SESSION-FORMAT.md).

Optional arguments: `--threshold 1` sets the internal trace threshold in whole milliseconds; `--lake /path/to/lake` chooses Lake. Ctrl-C cancels capture. The extension has equivalent `leanSourceProfiler.thresholdMs` and `leanSourceProfiler.lakePath` settings.

## What the bars mean

- **Inclusive** is the elapsed interval for the statement, including its children. Intervals on the same line are unioned, so repeated/nested wrappers do not inflate that line's bar. Nested statements on different lines can still share time; do not sum every bar in a proof.
- **Self** subtracts the union of recorded child intervals. It includes unrecorded work and events below the internal threshold. It is not a native CPU self-time measurement.
- **Recorded syntax range** comes from retained Lean syntax, including UTF-16 positions. **Inherited enclosing range** means an internal operation is attributed to its nearest recorded source context.
- Plain tactic-sequence wrappers are excluded from line bars. A `funext` line does not inherit the following `exact` statement's cost merely because the sequence starts there.
- **Expression reference** links are navigation only. **Recorded unfolding** means an explicit Lean trace reported an unfolding during the selected operation. A purple annotation at the definition gives this calling context; it does **not** claim the entire caller's time was spent on that definition's source line.
- Source snapshots are saved. Editing a file hides its bars until it matches the snapshot or you capture again.
- Imported declaration links are disabled with a **rebuild imports** badge when their source is newer than the compiled artifact, or artifact freshness cannot be checked. Build the imports and capture again. This is a modification-time guard; sources and compiled artifacts still need to come from the same checkout/toolchain.

Frontend elapsed time includes imports and elaboration; capture total also includes starting the driver, rendering expressions, resolving locations, and writing JSON. Detailed captures add overhead. Use a separate uninstrumented run for benchmark numbers. Large OAI `meanField_add` captures can take about 45 seconds to render and save, with recordings around 50 MB.

## Source mapping and limits

This ships an isolated Lean frontend that wraps imported elaborator registrations within the capture process. It preserves syntax on timed tactic/term operations and exports internal traces underneath them. It does not edit your proofs or installed toolchain.

The original Firefox profile format does not retain reliable Lean source ranges. Those files are rejected with instructions to recapture, rather than matched to source text heuristically. `trace.profiler.output.pp=true` alone cannot restore the missing ranges.

Source-level events are retained even below the configured threshold; internal traces are thresholded. Very deep expressions are truncated in display, with a visible marker. Source annotations are not an exact line-by-line profile of the implementation of Lean itself or of every unfolded definition. New elaborators registered inside the target file after its imports may have only enclosing-context attribution. Heartbeat-based trace clocks are rejected rather than mislabeled as milliseconds.

Capture executes the project's Lean code and therefore requires VS Code workspace trust. Viewing a recording does not execute its contents. All capture runs are local; there is no upload or telemetry in this extension.

## Development and tests

```sh
npm ci
npm run check
npm test
node test/capture.integration.cjs --skip-ns
node test/stale-import.integration.cjs
node test/declarations.capture.cjs
node test/collection.integration.cjs
npm run test:extension
npm run package
```

For NS integration tests, set `NS_BENCHMARK_ROOT` if the benchmark repository is not the sibling `ns-formalization-benchmark`, then run `node test/capture.integration.cjs`. These tests create and remove their own temporary source copies; they do not modify the original proofs. Extension-host tests use an isolated VS Code user-data directory. On systems other than this Mac, set `VSCODE_EXECUTABLE_PATH` to your VS Code executable.

See [the project profiling plan](docs/PROJECT-PROFILING-PLAN.md), [project validation results](docs/PROJECT-PROFILING-RESULTS.md), [the original implementation plan](docs/PLAN.md), [acceptance tests](docs/TEST-PLAN.md), [capture internals](lean/README.md), and [validation results](docs/TEST-RESULTS.md).
