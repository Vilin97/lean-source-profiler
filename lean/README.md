# Source-aware Lean capture

From the target Lake project directory:

```sh
lake env lean --run /absolute/path/SourceProfiler.lean \
  path/within/project/File.lean /absolute/path/profile.json 1
```

The final optional argument is the internal trace threshold in milliseconds (default 1).
The input must be inside the current project directory. Its real module name is derived from
that directory. The driver uses the project's `LEAN_PATH`, `LEAN_SRC_PATH`, and Lean toolchain.
It does not edit the input, build dependencies, replace Lean, or generate `.olean` files.

## Capture and attribution

The driver parses and imports the source once, instruments the in-memory term and tactic
elaborator registries, then invokes Lean's incremental command frontend. The original
elaborator functions run with their original inputs and expected types. Additional
`Source.tactic` and `Source.term` trace scopes retain their actual `Syntax` using
`MessageData.ofOriginatingSyntax`. These scopes are recorded even below the threshold;
internal `Meta`, `Elab`, and `Kernel` scopes use the requested threshold.

Macro expansion roots retain the original invocation range. This prevents generated
`apply`/`intro` calls for `funext` from borrowing the range of an entire proof block.
Generated child spans that escape their known parent span inherit the parent's range.
The exported `sourceKind` makes inherited attribution explicit. No expression-text matching
is used to find source lines.

All completed snapshot trace states, including asynchronous proof workers, are exported.
The node tree, thread IDs, and monotonic intervals are preserved. Seconds are converted to
milliseconds; UTF-8 syntax offsets are converted using Lean's LSP UTF-16 conversion.
`elapsedMs` measures frontend work including imports, before message formatting/export.
The host additionally records the wall time of the entire capture process.

Symbols come from semantic InfoTrees and semantic pretty-printer annotations. Their files
and declaration ranges come from the environment's declaration metadata and source path.
For imported declarations, the source modification time is compared with the compiled
module's `.olean` modification time. A newer source, missing source, or unverifiable
artifact is marked `sourceStale: true` and its declaration range is removed. Rebuilding
the import restores navigation when the compiled artifact is current. This is a
conservative timestamp check, not proof that source and artifact contents correspond:
preserved/restored timestamps can evade it, and touching unchanged source may disable
navigation until the artifact is rebuilt.
`kind: "reference"` means a declaration appears in the expression or source operation;
it does **not** mean the declaration's proof ran again or consumed the enclosing interval.

Explicit `Meta.isDefEq.delta.unfoldLeft`, `unfoldRight`, and `unfoldLeftRight` messages
provide `kind: "unfold"` evidence. They contain a fully qualified kernel declaration name,
which is checked against the environment before resolution. These messages have no own
timestamps: the reference is attached to the nearest retained timed parent. The parent
duration must not be presented as the exclusive cost of unfolding that declaration.

## Bounds and limitations

- The driver currently targets and is tested with Lean 4.34.0-rc2. Internal frontend APIs
  change between Lean releases; incompatibility fails explicitly during driver compilation.
- Imported elaborators/macros are instrumented. A new elaborator or macro registered later
  inside the source file itself is not wrapped; enclosing retained scopes still provide
  context, but such calls may lack their own exact range.
- This profiles elaboration and kernel checking, not execution of a compiled Lean program,
  native CPU stacks, heap allocations, or peak RSS.
- Trace collection adds overhead. Use uninstrumented compiler wall time for final benchmark
  numbers, and compare recordings captured with the same settings.
- Formatting happens after the timed frontend interval. Large traces can take substantially
  longer to format/export than the proof took to elaborate.
- Pretty printing is bounded to 500 steps/depth 12, details to 4,096 characters, and ordinary
  reference discovery to 24 names per event. Truncation is visible in the detail text.
- Source spans and declaration-level navigation are precise where Lean provides metadata.
  Line-level costs *inside* an unfolded definition are not reconstructed from expression
  reduction. Declaration references are navigation links, not fabricated source timings.
- Existing Firefox JSON lacks these source scopes and cannot retrospectively supply them.
- Source-local options that disable profiling or switch profiling to heartbeats can override
  driver options. Heartbeat traces are rejected explicitly. Do not disable profiling in
  files captured with this time-based driver.

## Verification performed

The independent fixture oracle covers separate lines, duplicate tactic text at different
locations, multiline tactics, nested tactics, a supplementary-plane character before a
tactic (UTF-16), and imported declaration navigation. The OAI and LeanPool
`meanField_add` reproductions retain separate `funext` and `exact` spans and the nested
definitional-equality/reduction scopes. Driver errors return a nonzero exit status;
completed captures also carry `success` and compiler diagnostics.
