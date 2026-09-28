# Screenshots

These are unaltered application captures of the included test fixtures, recorded with Lean 4.34.0-rc2. The displayed measurements come from real profiling runs and will vary between runs. Screenshot files were converted to PNG without changing their content.

## VS Code overlay

![Source timing annotations and nested calls in VS Code](vscode-overlay.png)

The `Accuracy.lean` fixture's `reductionWork` proof is selected. Its 4.3 ms `exact`
tactic includes term elaboration and a `Meta.isDefEq` call. Other timing bars show
nested proofs and uses of imported definitions in the same source file.

## Repository view

![Folder and file timing shares](repository-view.png)

The `CollectionSource` capture scope contains two files, including one in a nested folder. Folder percentages use the sum of successfully captured file times; the separate session wall time includes capture and export overhead.

## Source view

![Recorded source and declaration timing breakdown](source-view.png)

Source timing bars accompany the original proof. The selected declaration's 2.0 ms total is the union of its recorded intervals. Its four contributing operations remain available for drilling into their nested calls; their inclusive durations are not simply added together.
