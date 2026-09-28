#!/bin/sh
set -eu
installer_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
vsix_path="$installer_dir/lean-source-profiler-0.2.0.vsix"
if command -v code >/dev/null 2>&1; then
  code --install-extension "$vsix_path" --force
elif test -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; then
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension "$vsix_path" --force
else
  printf '%s\n' 'VS Code was not found. Install it, then use Extensions > Install from VSIX.'
  exit 1
fi
printf '%s\n' 'Installed. Open a Lean file and click the pulse button to profile it.'
