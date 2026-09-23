import Lean

/-!
Standalone source-aware profiler. Run in the target Lake project:
  lake env lean --run /path/to/SourceProfiler.lean Input.lean Output.json [thresholdMs]

The user's source and installed Lean are never modified. Elaborator registry values are
wrapped in this process only. The original Syntax is retained in structured trace data.
-/
open Lean Lean.Elab

namespace SourceProfiler

initialize registerTraceClass `Source.tactic
initialize registerTraceClass `Source.term

def wrapTactic (original : Tactic.Tactic) : Tactic.Tactic := fun stx =>
  withTraceNode `Source.tactic
    (fun _ => pure (.ofOriginatingSyntax stx (MessageData.ofSyntax stx)))
    (tag := stx.getKind.toString) (original stx)

def wrapTerm (original : Term.TermElab) : Term.TermElab := fun stx expectedType =>
  withTraceNode `Source.term
    (fun _ => pure (.ofOriginatingSyntax stx (MessageData.ofSyntax stx)))
    (tag := stx.getKind.toString) (original stx expectedType)

/-- A generated expansion is attributed to its actual invocation, not a surrounding block. -/
def wrapMacro (original : Macro) : Macro := fun stx => do
  let expanded ← original stx
  if let some r := stx.getRange? (canonicalOnly := true) then
    return expanded.setInfo (.synthetic r.start r.stop true)
  return expanded

def instrument (env : Environment) : Environment := Id.run do
  let env := Tactic.tacticElabAttribute.ext.modifyState env fun s =>
    { s with table := s.table.fold (init := {}) fun acc key entries =>
      acc.insert key (entries.map fun entry => { entry with value := wrapTactic entry.value }) }
  let env := Term.termElabAttribute.ext.modifyState env fun s =>
    { s with table := s.table.fold (init := {}) fun acc key entries =>
      acc.insert key (entries.map fun entry => { entry with value := wrapTerm entry.value }) }
  let env := macroAttribute.ext.modifyState env fun s =>
    { s with table := s.table.fold (init := {}) fun acc key entries =>
      acc.insert key (entries.map fun entry => { entry with value := wrapMacro entry.value }) }
  return env

structure Source where
  file : String
  start : Lsp.Position
  «end» : Lsp.Position
  deriving ToJson

structure Symbol where
  name : String
  file : Option String := none
  range : Option Lsp.Range := none
  kind : String := "reference"
  sourceStale : Bool := false
  sourceStaleReason : Option String := none
  deriving ToJson

structure Node where
  id : String
  parentId : Option String
  category : String
  label : String
  detail : String
  startMs : Float
  durationMs : Float
  thread : String
  source : Option Source := none
  sourceKind : Option String := none
  symbols : Array Symbol := #[]
  deriving ToJson

structure ExportState where
  nodes : Array Node := #[]
  symbolCache : Std.HashMap Name Symbol := {}

structure ExportContext where
  file : String
  fileMap : FileMap
  env : Environment
  sourcePaths : SearchPath
  startTime : Float
  thread : String := "0"
  references : Array (Lsp.Range × Name) := #[]

abbrev ExportM := ReaderT ExportContext (StateT ExportState IO)

def syntaxSource (ctx : ExportContext) (stx : Syntax) : Option Source := do
  let range ← ctx.fileMap.lspRangeOfStx? stx (canonicalOnly := true)
  return { file := ctx.file, start := range.start, «end» := range.end }

partial def collectReferences (fileMap : FileMap) (tree : InfoTree)
    (acc : Array (Lsp.Range × Name) := #[]) : Array (Lsp.Range × Name) :=
  match tree with
  | .context _ tree => collectReferences fileMap tree acc
  | .node info children => Id.run do
    let mut acc := acc
    if let .ofTermInfo info := info then
      if let .const name _ := info.expr.getAppFn then
        if let some range := fileMap.lspRangeOfStx? info.stx (canonicalOnly := true) then
          acc := acc.push (range, name)
    return children.foldl (fun acc tree => collectReferences fileMap tree acc) acc
  | .hole _ => acc

partial def originatingSyntax? : MessageData → Option Syntax
  | .ofOriginatingSyntax stx _ => some stx
  | .withContext _ msg | .withNamingContext _ msg | .nest _ msg | .group msg
  | .tagged _ msg | .ofWidget _ msg => originatingSyntax? msg
  | .compose a b => originatingSyntax? a <|> originatingSyntax? b
  | _ => none

def resolveSymbol (name : Name) : ExportM Symbol := do
  if let some sym := (← get).symbolCache[name]? then return sym
  let ctx ← read
  let mut sym : Symbol := { name := name.toString }
  let ranges := declRangeExt.find? (level := .exported) ctx.env name <|>
    declRangeExt.find? (level := .server) ctx.env name <|>
    (← builtinDeclRanges.get).find? name
  if let some ranges := ranges then
    let r := ranges.range
    sym := { sym with range := some {
      start := ⟨r.pos.line - 1, r.charUtf16⟩,
      «end» := ⟨r.endPos.line - 1, r.endCharUtf16⟩ } }
  if let some idx := ctx.env.getModuleIdxFor? name then
    let mod := ctx.env.header.moduleNames[idx.toNat]!
    -- Declaration ranges came from the compiled import. A newer on-disk source
    -- cannot safely be presented as the source that produced those ranges.
    sym := { sym with
      sourceStale := true
      sourceStaleReason := some "Imported source freshness could not be verified against its compiled .olean." }
    try
      let path ← findLean ctx.sourcePaths mod
      sym := { sym with file := some (← IO.FS.realPath path).toString }
      let compiled ← findOLean mod
      let sourceMetadata ← path.metadata
      let compiledMetadata ← compiled.metadata
      if sourceMetadata.modified > compiledMetadata.modified then
        sym := { sym with
          sourceStaleReason := some "Imported source is newer than its compiled .olean. Rebuild imports and profile again." }
      else
        sym := { sym with sourceStale := false, sourceStaleReason := none }
    catch _ => pure ()
    if sym.sourceStale then sym := { sym with range := none }
  else if ctx.env.contains name then
    sym := { sym with file := some ctx.file }
  modify fun s => { s with symbolCache := s.symbolCache.insert name sym }
  return sym

/-- Materialize lazy messages once, retaining the semantic pretty-printer annotations. -/
partial def materialize (msg : MessageData) (ctx? : Option PPContext)
    (fuel : Nat := 64) : BaseIO (MessageData × Std.HashSet Name) := do
  if fuel == 0 then return (msg, {})
  match msg with
  | .ofLazy f _ =>
    let dyn ← f ctx?
    if let some msg := dyn.get? MessageData then materialize msg ctx? (fuel - 1)
    else return (MessageData.ofFormat "<unavailable>", {})
  | .withContext ctx body =>
    let ctx := { ctx with opts := (ctx.opts.set `pp.maxSteps (500 : Nat)
      |>.set `pp.deepTerms.threshold (12 : Nat)) }
    let ppCtx := MessageData.mkPPContext { currNamespace := .anonymous, openDecls := [] } ctx
    let (body, names) ← materialize body (some ppCtx) (fuel - 1)
    return (.withContext ctx body, names)
  | .ofFormatWithInfos fmt =>
    let names := fmt.infos.foldl (init := {}) fun acc _ info =>
      match info with
      | .ofTermInfo info => if acc.size >= 24 then acc else
          match info.expr.getAppFn with
          | .const name _ => acc.insert name
          | _ => acc
      | .ofFieldInfo info => acc.insert info.projName
      | _ => acc
    return (msg, names)
  | .compose a b =>
    let (a, ns) ← materialize a ctx? (fuel - 1)
    let (b, ms) ← materialize b ctx? (fuel - 1)
    return (.compose a b, ms.fold (init := ns) fun s n => s.insert n)
  | .nest n b =>
    let (b, ns) ← materialize b ctx? (fuel - 1)
    return (.nest n b, ns)
  | .group b =>
    let (b, ns) ← materialize b ctx? (fuel - 1)
    return (.group b, ns)
  | .tagged n b =>
    let (b, ns) ← materialize b ctx? (fuel - 1)
    return (.tagged n b, ns)
  | .ofOriginatingSyntax stx b =>
    let (b, ns) ← materialize b ctx? (fuel - 1)
    return (.ofOriginatingSyntax stx b, ns)
  | .withNamingContext nc b =>
    let (b, ns) ← materialize b (ctx?.map fun c => { c with currNamespace := nc.currNamespace, openDecls := nc.openDecls }) (fuel - 1)
    return (.withNamingContext nc b, ns)
  | _ => return (msg, {})

partial def visit (msg : MessageData) (parentId : Option String)
    (inherited : Option Source) (ctx? : Option PPContext := none)
    (rootRef? : Option Syntax := none) : ExportM Unit := do
  match msg with
  | .withContext ctx msg =>
    let ctx := { ctx with opts := (ctx.opts.set `pp.maxSteps (500 : Nat)
      |>.set `pp.deepTerms.threshold (12 : Nat)) }
    visit msg parentId inherited (some <| MessageData.mkPPContext { currNamespace := .anonymous, openDecls := [] } ctx) rootRef?
  | .withNamingContext nc msg =>
    visit msg parentId inherited (ctx?.map fun c => { c with currNamespace := nc.currNamespace, openDecls := nc.openDecls }) rootRef?
  | .trace data body children =>
    if ctx?.any (fun ctx => trace.profiler.useHeartbeats.get ctx.opts) then
      throw <| IO.userError "Source profiler requires wall-clock traces. Remove `set_option trace.profiler.useHeartbeats true` from the profiled source."
    if data.startTime == 0 then
      if data.cls == `Meta.isDefEq.delta.unfoldLeft || data.cls == `Meta.isDefEq.delta.unfoldRight || data.cls == `Meta.isDefEq.delta.unfoldLeftRight then
        if let some parentId := parentId then
          if let some parentIndex := parentId.toNat? then
            let nameText := (← body.format (ctx?.map fun c => { env := c.env, mctx := c.mctx, lctx := c.lctx, opts := c.opts })).pretty 100000
            let name := nameText.toName
            if (← read).env.contains name then
              let symbol := { (← resolveSymbol name) with kind := "unfold" }
              modify fun s => { s with nodes := s.nodes.modify parentIndex (fun n =>
                if n.symbols.any (fun s => s.name == symbol.name && s.kind == "unfold") then n
                else { n with symbols := n.symbols.push symbol }) }
      for child in children do visit child parentId inherited ctx?
      return
    let ctx ← read
    let ownSource := (originatingSyntax? body <|> rootRef?).bind (syntaxSource ctx)
    let ownSource := match ownSource, inherited with
      | some own, some inherited =>
        if own.start < inherited.start || inherited.end < own.end then none else some own
      | own, _ => own
    let source := ownSource <|> inherited
    let (body, names) ← materialize body ctx?
    let detail := (← body.format (ctx?.map fun c => { env := c.env, mctx := c.mctx, lctx := c.lctx, opts := c.opts })).pretty 120
    let detail := if detail.length > 4096 then detail.take 4096 |>.toString |>.append "… [truncated]" else detail
    let id := toString (← get).nodes.size
    let mut names := names
    if data.cls == `Source.tactic || data.cls == `Source.term then
      if let some source := source then
        for (range, name) in ctx.references do
          if source.start ≤ range.start && range.end ≤ source.end && names.size < 24 then
            names := names.insert name
    let symbols ← names.toArray.mapM resolveSymbol
    let node : Node := {
      id, parentId, category := data.cls.toString,
      label := if data.tag.isEmpty then data.cls.toString else s!"{data.cls}: {data.tag}"
      detail, startMs := (data.startTime - ctx.startTime) * 1000
      durationMs := (data.stopTime - data.startTime) * 1000
      thread := ctx.thread, source
      sourceKind := if ownSource.isSome then some "exact" else if source.isSome then some "inherited" else none
      symbols
    }
    modify fun s => { s with nodes := s.nodes.push node }
    for child in children do visit child (some id) source ctx?
  | .ofOriginatingSyntax stx msg => visit msg parentId inherited ctx? (some stx)
  | _ => pure ()

def run (inputFile outputFile : String) (threshold : Nat) : IO UInt32 := do
  initSearchPath (← findSysroot)
  unsafe enableInitializersExecution
  let path ← IO.FS.realPath inputFile
  let input ← IO.FS.readFile path
  let inputCtx := Parser.mkInputContext input path.toString
  let opts := Options.empty |>.setBool `trace.profiler true
    |>.set `trace.profiler.threshold threshold
    |>.setBool `trace.Source.tactic true
    |>.setBool `trace.Source.term true
    |>.setBool `trace.Meta.isDefEq.delta.unfoldLeft true
    |>.setBool `trace.Meta.isDefEq.delta.unfoldRight true
    |>.setBool `trace.Meta.isDefEq.delta.unfoldLeftRight true
    |>.set `trace.profiler.output "__source_profiler_retained__"
    |>.setBool `Elab.async true
    |>.setBool `internal.cmdlineSnapshots false
  let startTime := (← IO.monoNanosNow).toFloat / 1000000000
  let (header, parserState, messages) ← Parser.parseHeader inputCtx
  let mainModule ← moduleNameOfFileName path none
  let (env, messages) ← processHeader ⟨header⟩ opts messages inputCtx (mainModule := mainModule)
  -- The incremental command snapshot tree does not retain header/import diagnostics.
  -- Report them here and stop before trying to elaborate against an empty environment.
  for message in messages.toList do
    IO.eprintln (← message.toString)
  if messages.hasErrors then return 1
  let env := instrument env
  let state := Command.mkState env messages opts
  let result ← IO.processCommandsIncrementally inputCtx parserState state none
  let snaps := Language.toSnapshotTree result.initialSnap
  let hasErrors ← snaps.runAndReport opts false {}
  let stopTime := (← IO.monoNanosNow).toFloat / 1000000000
  IO.eprintln "Elaboration finished; formatting source traces and resolving declarations…"
  let sourcePaths ← getSrcSearchPath
  let references := result.commandState.infoState.trees.foldl (fun refs tree =>
    collectReferences inputCtx.fileMap tree refs) #[]
  let ctx : ExportContext := {
    file := path.toString, fileMap := inputCtx.fileMap,
    env := result.commandState.env, sourcePaths, startTime, references }
  let (_, exported) ← (do
    for snap in snaps.getAll do
      withReader (fun ctx => { ctx with thread := toString snap.traces.tid }) do
        for trace in snap.traces.traces do
          visit trace.msg none none none (some trace.ref)
    : ExportM Unit).run ctx |>.run {}
  let diagnostics ← (messages.toList ++ result.commandState.messages.toList).toArray.mapM fun msg => do
    return Json.mkObj [("severity", toJson (toString msg.severity)),
      ("message", toJson (← msg.data.toString))]
  let json := Json.mkObj [
    ("schemaVersion", toJson (1 : Nat)), ("leanVersion", toJson Lean.versionString),
    ("sourceFile", toJson path.toString), ("sourceText", toJson input),
    ("elapsedMs", toJson ((stopTime - startTime) * 1000)),
    ("nodes", toJson exported.nodes), ("diagnostics", toJson diagnostics),
    ("success", toJson (!hasErrors)), ("thresholdMs", toJson threshold),
    ("captureMethod", toJson "structured-elaborator-wrappers")]
  IO.FS.writeFile outputFile json.compress
  IO.println s!"Source profile: {exported.nodes.size} events → {outputFile}"
  return if hasErrors then 1 else 0

end SourceProfiler

def main (args : List String) : IO UInt32 := do
  match args with
  | [input, output] => SourceProfiler.run input output 1
  | [input, output, threshold] =>
    let some threshold := threshold.toNat?
      | throw <| IO.userError "threshold must be a nonnegative integer in milliseconds"
    SourceProfiler.run input output threshold
  | _ =>
    IO.eprintln "Usage: lake env lean --run SourceProfiler.lean INPUT.lean OUTPUT.json [THRESHOLD_MS]"
    return 2
