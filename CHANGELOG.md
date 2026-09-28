# Changelog

## 0.2.0

- Capture directories and projects sequentially, with exclusions, checkpoints, explicit failures and cancellation preservation.
- Add session manifests and a compact JSONL index for file, folder, declaration and tactic queries.
- Retain semantic declaration ranges and asynchronous proof scopes below trace thresholds.
- Add a local standalone repository viewer with percentage drill-down, rankings, source bars and nested operations.
- Browse session files for VS Code overlays and open the standalone viewer from the extension.
- Share a capture lock across commands and cancel detached Lean processes on SIGINT/SIGTERM.

## 0.1.0

- Capture Lean elaboration using retained syntax ranges without rebuilding Lean.
- Overlay source timing bars and clickable timing annotations in VS Code.
- Inspect nested operations, full trace details, and source/definition links.
- Distinguish recorded unfolding evidence from ordinary expression references.
- Hide source overlays when buffers differ from the recording.
- Provide saved JSON recordings, terminal capture/open commands, cancellation, and local VSIX installation.
- Validate source mapping against Unicode, repeated/multiline/nested tactics and OAI/LeanPool Navier–Stokes proof examples.
