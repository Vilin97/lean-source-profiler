# Screenshots

These are unaltered application captures of the actual LeanPool example and included test fixtures, recorded with Lean 4.34.0-rc2. The displayed measurements come from real profiling runs and will vary between runs. Screenshot files were converted to PNG without changing their content.

## LeanPool example

![Actual LeanPool meanField_add proof and nested operations](leanpool-example.png)

This is the [interactive public example](https://vilin97.github.io/lean-source-profiler/examples/leanpool/#file=0&event=2356), captured from the actual LeanPool `ActualCandidateAssembly.lean` module. The `exact` tactic takes 24.1 ms of recorded elapsed time; its nested term elaboration and `Meta.isDefEq` calls are shown beside the original source. See [provenance](../LEANPOOL-EXAMPLE.md) for the revision and capture settings.

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
