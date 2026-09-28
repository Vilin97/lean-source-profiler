# Install Lean Source Profiler

## VS Code: download and install

1. [Download the latest VS Code extension](https://github.com/Vilin97/lean-source-profiler/releases/latest/download/lean-source-profiler.vsix).
2. In VS Code, open **Extensions**, select **… → Install from VSIX…**, and choose the downloaded file.
3. Open a Lean project and a saved `.lean` file. Click the **pulse** button above the editor, or run **Lean Source Profiler: Profile Current File** from the Command Palette.

Timing annotations appear over the source after capture. Click an annotation to
inspect its nested work and follow definition links.

![Clickable timing annotations in VS Code](screenshots/vscode-overlay.png)

You do not need npm or a separate Node.js installation for the VS Code extension.
It includes its JavaScript and Lean capture driver.

**Optional macOS helper:** [download the macOS ZIP](https://github.com/Vilin97/lean-source-profiler/releases/latest/download/lean-source-profiler-macos.zip),
extract it, and double-click **Install Lean Source Profiler.command**. If macOS
blocks the helper, use **Install from VSIX…** with the extension inside the ZIP.

## Before profiling

Have VS Code and the **Lean 4** extension installed for Lean editing. Your Lean
project needs elan/Lake and already-built imports; run `lake build` in the project
if needed. Capture uses the project's own Lean toolchain and requires a trusted
VS Code workspace.

Capture has been validated with **Lean 4.34.0-rc2**, **VS Code 1.138.0**, and
**macOS on Apple Silicon**. Other Lean versions may need changes to the capture
driver. Viewing existing recordings does not require Lean; other operating
systems have not been validated.

## Profile a folder or project

Use **Lean Source Profiler: Profile Folder** or **Profile Project** from the
Command Palette. You can also right-click a folder in Explorer and choose
**Profile Folder**.

To view a saved capture, run **Lean Source Profiler: Open Profile** and select
its `.leanprofile.json` file or `session.json`. **Browse Session Sources** switches
between files in a session. **Open Standalone Viewer** opens the recording in
your browser.

![Repository costs in the standalone viewer](screenshots/repository-view.png)

![Source timings and nested operations in the standalone viewer](screenshots/source-view.png)

## Command line: one installation command

With **Node.js 20 or newer** and npm installed:

```sh
npm install -g https://github.com/Vilin97/lean-source-profiler/releases/latest/download/lean-source-profiler-cli.tgz
```

The release package is already built. You do not need to clone the repository or
run a build command.

From your Lean project's directory:

```sh
lean-profile profile . --output .leanprofiles/first-session
lean-profile view .leanprofiles/first-session
lean-profile query .leanprofiles/first-session --kind declaration --limit 10 --json
```

The viewer opens locally in your browser; press **Ctrl-C** in its terminal to stop
it. Use a new output directory for each folder/project capture. To profile one
file, pass its path instead of `.`.

The CLI also supports `lean-profile open RECORDING` to open source overlays in
VS Code. That command requires the extension above and VS Code's `code` command
on your terminal's `PATH`.

## Updating

Install the latest VSIX again, or rerun the npm installation command. Release
downloads and version notes are on the [releases page](https://github.com/Vilin97/lean-source-profiler/releases).
