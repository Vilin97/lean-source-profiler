import Lean

/-!
Standalone source-aware profiler. Run in the target Lake project:
  lake env lean --run /path/to/SourceProfiler.lean Input.lean Output.json [thresholdMs]

The user's source and installed Lean are never modified. Elaborator registry values are
wrapped in this process only. The original Syntax is retained in structured trace data.
-/
open Lean Lean.Elab

namespace SourceProfiler

/-- Same runtime binding as Lean.Shell's private command-line default, used in native runs. -/
@[extern "lean_internal_get_believer_trust_level"]
def believerTrustLevel (_ : Unit) : UInt32 := 0

/-- Native Linux builds supply an independent raw elapsed clock. Interpreted runs avoid
this external declaration and are never advertised as raw calibration. -/
@[extern "lsp_raw_nanos_now"] def rawNanosNow : BaseIO Nat := IO.monoNanosNow

structure ClockMapping where
  startTime : Float
  rawStartTime : Float
  importTime : Float
  importElapsed : Float
  stopTime : Float
  elapsed : Float
  deriving ToJson

/-- Piecewise calibration separates import loading and source elaboration. -/
def ClockMapping.at (clock : ClockMapping) (time : Float) : Float :=
  if time <= clock.importTime && clock.importTime > clock.startTime then
    (time - clock.startTime) * clock.importElapsed / (clock.importTime - clock.startTime)
  else if clock.stopTime > clock.importTime then
    clock.importElapsed + (time - clock.importTime) * (clock.elapsed - clock.importElapsed) /
      (clock.stopTime - clock.importTime)
  else time - clock.startTime

initialize registerTraceClass `Source.tactic
initialize registerTraceClass `Source.term

/-- Source timers avoid constructing diagnostic contexts and timing every internal Meta call.
The exception instance matches Lean's trace builder, so failed elaborator alternatives
restore their parent trace state before rethrowing. -/
def withSourceTrace {m : Type → Type} {α : Type} [Monad m] [MonadTrace m]
    [MonadOptions m] [MonadWithOptions m] [MonadLiftT BaseIO m]
    [always : MonadAlwaysExcept Exception m] [ExceptToTraceResult Exception α]
    (cls : Name) (stx : Syntax) (action : m α) : m α := do
  let opts ← getOptions
  let _ := always.except
  if trace.profiler.useHeartbeats.get opts then
    throw <| Exception.error stx "Source profiler requires wall-clock traces."
  let action := if trace.profiler.get opts then
    withOptions (·.setBool `trace.profiler false) action else action
  -- Generated, unlocated syntax is covered by its enclosing source timer.
  if stx.getRange? (canonicalOnly := true) |>.isNone then return ← action
  let oldTraces ← getTraces
  modifyTraces fun _ => {}
  let rawClock := opts.getBool `sourceProfiler.rawClock false
  let start ← if rawClock then rawNanosNow else IO.monoNanosNow
  let result ← observing action
  let stop ← if rawClock then rawNanosNow else IO.monoNanosNow
  let data : TraceData := {
    cls, tag := stx.getKind.toString, result? := some result.toTraceResult
    startTime := start.toFloat / 1000000000, stopTime := stop.toFloat / 1000000000 }
  let body := MessageData.ofOriginatingSyntax stx (MessageData.ofSyntax stx)
  let msg := MessageData.trace data body ((← getTraces).toArray.map (·.msg))
  modifyTraces fun _ => oldTraces.push { ref := stx, msg }
  MonadExcept.ofExcept result

def wrapTactic (original : Tactic.Tactic) (sourceOnly := false) : Tactic.Tactic := fun stx => do
  if sourceOnly then return ← withSourceTrace `Source.tactic stx (original stx)
  withTraceNode `Source.tactic
    (fun _ => pure (.ofOriginatingSyntax stx (MessageData.ofSyntax stx)))
    (tag := stx.getKind.toString)
    (original stx)

def wrapTerm (original : Term.TermElab) (sourceOnly := false) : Term.TermElab := fun stx expectedType => do
  if sourceOnly then return ← withSourceTrace `Source.term stx (original stx expectedType)
  withTraceNode `Source.term
    (fun _ => pure (.ofOriginatingSyntax stx (MessageData.ofSyntax stx)))
    (tag := stx.getKind.toString)
    (original stx expectedType)

/-- A generated expansion is attributed to its actual invocation, not a surrounding block. -/
def wrapMacro (original : Macro) : Macro := fun stx => do
  let expanded ← original stx
  if let some r := stx.getRange? (canonicalOnly := true) then
    return expanded.setInfo (.synthetic r.start r.stop true)
  return expanded

def instrument (env : Environment) (sourceOnly := false) : Environment := Id.run do
  let env := Tactic.tacticElabAttribute.ext.modifyState env fun s =>
    { s with table := s.table.fold (init := {}) fun acc key entries =>
      acc.insert key (entries.map fun entry => { entry with value := wrapTactic entry.value sourceOnly }) }
  let env := Term.termElabAttribute.ext.modifyState env fun s =>
    { s with table := s.table.fold (init := {}) fun acc key entries =>
      acc.insert key (entries.map fun entry => { entry with value := wrapTerm entry.value sourceOnly }) }
  let env := macroAttribute.ext.modifyState env fun s =>
    { s with table := s.table.fold (init := {}) fun acc key entries =>
      acc.insert key (entries.map fun entry => { entry with value := wrapMacro entry.value }) }
  return env

structure Source where
  file : String
  start : Lsp.Position
  «end» : Lsp.Position
  deriving ToJson

/-- Semantic declaration identities and locations, independent of trace display text. -/
structure Declaration where
  name : String
  source : Source
  kind : String
  generated : Bool := false
  deriving ToJson

def declarationKind : ConstantKind → String
  | .defn => "definition"
  | .thm => "theorem"
  | .axiom => "axiom"
  | .opaque => "opaque"
  | .quot => "quotient"
  | .induct => "inductive"
  | .ctor => "constructor"
  | .recursor => "recursor"

/-- Only local constants with genuine declaration-range metadata are exported. -/
def collectDeclarations (env : Environment) (file : String) : BaseIO (Array Declaration) := do
  let mut declarations := #[]
  for info in ← env.getLocalConstantInfos do
    if env.getModuleIdxFor? info.name |>.isSome then continue
    let ranges := declRangeExt.find? env info.name <|>
      declRangeExt.find? (level := .server) env info.name
    let some ranges := ranges | continue
    let r := ranges.range
    if r.pos.line == 0 || r.endPos.line == 0 then continue
    declarations := declarations.push {
      name := info.name.toString
      source := {
        file := file
        start := ⟨r.pos.line - 1, r.charUtf16⟩
        «end» := ⟨r.endPos.line - 1, r.endCharUtf16⟩ }
      kind := declarationKind info.kind
      generated := (privateToUserName info.name).isInternalDetail || info.kind == .recursor
    }
  return declarations

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
  clockMapping : Option ClockMapping := none
  rawSourceClock : Bool := false
  thread : String := "0"
  references : Array (Lsp.Range × Name) := #[]

abbrev ExportM := ReaderT ExportContext (StateT ExportState IO)

structure CompactState where
  events : Array Json := #[]
  classes : Array (String × String) := #[]
  classIds : Std.HashMap (Name × String) Nat := {}
  ranges : Array (Nat × Nat × Nat × Nat) := #[]
  rangeIds : Std.HashMap (Nat × Nat × Nat × Nat) Nat := {}

abbrev CompactM := ReaderT ExportContext (StateT CompactState IO)

def ExportContext.timeMs (ctx : ExportContext) (time : Float) (cls : Name) : Float :=
  if ctx.rawSourceClock && (cls == `Source.tactic || cls == `Source.term) then
    (time - (ctx.clockMapping.map (·.rawStartTime) |>.getD ctx.startTime)) * 1000
  else (ctx.clockMapping.map (·.at time) |>.getD (time - ctx.startTime)) * 1000

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
      detail, startMs := ctx.timeMs data.startTime data.cls
      durationMs := ctx.timeMs data.stopTime data.cls - ctx.timeMs data.startTime data.cls
      thread := ctx.thread, source
      sourceKind := if ownSource.isSome then some "exact" else if source.isSome then some "inherited" else none
      symbols
    }
    modify fun s => { s with nodes := s.nodes.push node }
    for child in children do visit child (some id) source ctx?
  | .ofOriginatingSyntax stx msg => visit msg parentId inherited ctx? (some stx)
  | _ => pure ()

/-- Retain the same intervals and source ownership without evaluating trace messages. -/
partial def visitCompact (msg : MessageData) (parent : Int := -1)
    (inherited : Option Source := none) (rootRef? : Option Syntax := none) : CompactM Unit := do
  match msg with
  | .withContext ctx msg =>
    if trace.profiler.useHeartbeats.get ctx.opts then
      throw <| IO.userError "Source profiler requires wall-clock traces; useHeartbeats is enabled."
    visitCompact msg parent inherited rootRef?
  | .withNamingContext _ msg => visitCompact msg parent inherited rootRef?
  | .ofOriginatingSyntax stx msg => visitCompact msg parent inherited (some stx)
  | .trace data body children =>
    if data.startTime == 0 then
      for child in children do visitCompact child parent inherited
      return
    let ctx ← read
    let ownSource := (originatingSyntax? body <|> rootRef?).bind (syntaxSource ctx)
    let ownSource := match ownSource, inherited with
      | some own, some outer =>
        if own.start < outer.start || outer.end < own.end then none else some own
      | own, _ => own
    let source := ownSource <|> inherited
    let mut rangeId : Int := -1
    if let some source := source then
      let key := (source.start.line, source.start.character, source.end.line, source.end.character)
      let id ← match (← get).rangeIds[key]? with
        | some id => pure id
        | none => do
          let id := (← get).ranges.size
          modify fun s => { s with ranges := s.ranges.push key, rangeIds := s.rangeIds.insert key id }
          pure id
      rangeId := Int.ofNat id
    let key := (data.cls, data.tag)
    let classId ← match (← get).classIds[key]? with
      | some id => pure id
      | none => do
        let id := (← get).classes.size
        let category := data.cls.toString
        let label := if data.tag.isEmpty then category else s!"{category}: {data.tag}"
        modify fun s => { s with
          classes := s.classes.push (category, label)
          classIds := s.classIds.insert key id }
        pure id
    let id := (← get).events.size
    let row := Json.arr #[toJson parent, toJson classId,
      toJson (ctx.timeMs data.startTime data.cls),
      toJson (ctx.timeMs data.stopTime data.cls - ctx.timeMs data.startTime data.cls), toJson ctx.thread,
      toJson rangeId, toJson (if ownSource.isSome then 1 else if source.isSome then 2 else 0 : Nat)]
    modify fun s => { s with events := s.events.push row }
    for child in children do visitCompact child (Int.ofNat id) source
  | _ => pure ()

def run (inputFile outputFile : String) (threshold : Nat) (mode := "detailed") : IO UInt32 := do
  initSearchPath (← findSysroot)
  unsafe enableInitializersExecution
  let path ← IO.FS.realPath inputFile
  let input ← IO.FS.readFile path
  let inputCtx := Parser.mkInputContext input path.toString
  let native := (← IO.getEnv "LEAN_SOURCE_PROFILER_NATIVE").getD "0" == "1"
  let requestedClock ← IO.getEnv "LEAN_SOURCE_PROFILER_CLOCK"
  let clock := if native then requestedClock.getD "Lean IO.monoNanosNow"
    else "Lean IO.monoNanosNow"
  let calibrated := native && clock != "Lean IO.monoNanosNow"
  unless mode == "compact" || mode == "detailed" || mode == "baseline" || mode == "verify" do
    throw <| IO.userError "Capture mode must be compact, detailed or baseline."
  let mainModule ← moduleNameOfFileName path none
  let setupFile := (System.FilePath.mk ".lake/build/ir") /
    (mainModule.toString.replace "." "/" ++ ".setup.json")
  let setup? ← if ← setupFile.pathExists then some <$> ModuleSetup.load setupFile else pure none
  if let some setup := setup? then
    unless setup.name == mainModule do throw <| IO.userError "Lake setup names a different module."
  -- Match runFrontend's command-line defaults without overriding explicit project options.
  let configuredOpts := setup?.map (·.options.toOptions) |>.getD Options.empty
  let baseOpts := Lean.Elab.async.setIfNotSet configuredOpts true
  let baseOpts := Lean.internal.cmdlineSnapshots.setIfNotSet baseOpts true
  let sourceOnly := mode == "compact" || mode == "verify"
  let tracedOpts := baseOpts |>.setBool `trace.profiler true
    |>.setBool `sourceProfiler.rawClock (sourceOnly && calibrated)
    |>.set `trace.profiler.threshold threshold
    |>.setBool `trace.Source.tactic (!sourceOnly)
    |>.setBool `trace.Source.term (!sourceOnly)
    -- Retain declaration dispatch and async proof/kernel scopes even for fast declarations.
    -- Consumers union these intervals by semantic declaration range; dispatch alone omits
    -- asynchronous theorem bodies and does not measure the declaration's elapsed work.
    |>.setBool `trace.Elab.command true
    |>.setBool `trace.Elab.async true
    |>.setBool `trace.Elab.definition.header true
    |>.setBool `trace.Elab.definition.value true
    |>.setBool `trace.Meta.isDefEq.delta.unfoldLeft (!sourceOnly)
    |>.setBool `trace.Meta.isDefEq.delta.unfoldRight (!sourceOnly)
    |>.setBool `trace.Meta.isDefEq.delta.unfoldLeftRight (!sourceOnly)
    |>.set `trace.profiler.output "__source_profiler_retained__"
  let opts := if mode == "baseline" then baseOpts else tracedOpts
  let startTime := (← IO.monoNanosNow).toFloat / 1000000000
  let rawStart ← if calibrated then rawNanosNow else IO.monoNanosNow
  if let some setup := setup? then setup.dynlibs.forM Lean.loadDynlib
  let (headerSyntax, parserState, messages) ← Parser.parseHeader inputCtx
  let header : HeaderSyntax := ⟨headerSyntax⟩
  let (env, messages) ← processHeaderCore header.startPos
    (setup?.bind (·.imports?) |>.getD header.imports)
    (setup?.any (·.isModule) || header.isModule) opts messages inputCtx
    (trustLevel := if native then believerTrustLevel () + 1 else 1) (leakEnv := true)
    (plugins := setup?.map (·.plugins) |>.getD #[]) (mainModule := mainModule)
    (package? := setup?.bind (·.package?))
    (arts := setup?.map (·.importArts) |>.getD {}) (headerStx? := some header)
  let importTime := (← IO.monoNanosNow).toFloat / 1000000000
  let rawImport ← if calibrated then rawNanosNow else IO.monoNanosNow
  -- The incremental command snapshot tree does not retain header/import diagnostics.
  -- Report them here and stop before trying to elaborate against an empty environment.
  for message in messages.toList do
    IO.eprintln (← message.toString)
  if messages.hasErrors then return 1
  let env := if mode == "baseline" then env else instrument env sourceOnly
  let state := Command.mkState env messages opts
  let result ← IO.processCommandsIncrementally inputCtx parserState state none
  let snaps := Language.toSnapshotTree result.initialSnap
  let hasErrors ← snaps.runAndReport opts false {}
  -- Force completion before stopping the timer, including asynchronous kernel work.
  let _ ← IO.wait result.commandState.env.checked
  let stopTime := (← IO.monoNanosNow).toFloat / 1000000000
  let rawStop ← if calibrated then rawNanosNow else IO.monoNanosNow
  let mapping : ClockMapping := {
    startTime, importTime, stopTime
    rawStartTime := rawStart.toFloat / 1000000000
    importElapsed := (rawImport - rawStart).toFloat / 1000000000
    elapsed := (rawStop - rawStart).toFloat / 1000000000 }
  let clockMapping := if calibrated then some mapping else none
  let elapsedMs := (if calibrated then mapping.elapsed else stopTime - startTime) * 1000
  if mode == "baseline" then
    IO.FS.writeFile outputFile (Json.mkObj [
      ("success", toJson (!hasErrors)), ("leanVersion", toJson Lean.versionString),
      ("elapsedMs", toJson elapsedMs)]).compress
    Runtime.forget result
    Runtime.forget snaps
    return if hasErrors then 1 else 0
  if mode == "compact" || mode == "verify" then
    let declarations ← collectDeclarations result.commandState.env path.toString
    let ctx : ExportContext := {
      file := path.toString, fileMap := inputCtx.fileMap
      env := result.commandState.env, sourcePaths := [], startTime, clockMapping
      rawSourceClock := calibrated }
    let (_, exported) ← (do
      for snap in snaps.getAll do
        withReader (fun ctx => { ctx with thread := toString snap.traces.tid }) do
          for trace in snap.traces.traces do
            visitCompact trace.msg (-1) none (some trace.ref)
      : CompactM Unit).run ctx |>.run {}
    let json := Json.mkObj [
      ("schemaVersion", toJson (3 : Nat)), ("kind", toJson "lean-source-profile-compact"),
      ("leanVersion", toJson Lean.versionString), ("sourceFile", toJson path.toString),
      ("sourceText", toJson input), ("elapsedMs", toJson elapsedMs),
      ("classes", toJson exported.classes), ("ranges", Json.arr (exported.ranges.map
        fun (a, b, c, d) => Json.arr #[toJson a, toJson b, toJson c, toJson d])),
      ("events", Json.arr exported.events), ("declarations", toJson declarations),
      ("success", toJson (!hasErrors)), ("thresholdMs", toJson threshold),
      ("captureMode", toJson mode), ("clock", toJson clock),
      ("sourceClock", toJson (if calibrated then "CLOCK_MONOTONIC_RAW" else "Lean IO.monoNanosNow")),
      ("clockCalibration", toJson clockMapping),
      ("traceScope", toJson "source"),
      ("moduleSetup", Json.mkObj [
        ("mode", toJson (if setup?.isSome then "lake" else "plain")),
        ("file", toJson (setup?.map fun _ => setupFile.toString)),
        ("options", toJson (setup?.map (·.options) |>.getD {}))]),
      ("exportPreparationMs", toJson (((← IO.monoNanosNow).toFloat / 1000000000 - stopTime) * 1000))]
    let destination := if mode == "verify" then outputFile ++ ".compact.json" else outputFile
    IO.FS.writeFile destination json.compress
    IO.println s!"Source profile: {exported.events.size} compact events → {outputFile}"
    if mode == "compact" then
      Runtime.forget result
      Runtime.forget snaps
      return if hasErrors then 1 else 0
  IO.eprintln "Elaboration finished; formatting source traces and resolving declarations…"
  let sourcePaths ← getSrcSearchPath
  let declarations ← collectDeclarations result.commandState.env path.toString
  let references := result.commandState.infoState.trees.foldl (fun refs tree =>
    collectReferences inputCtx.fileMap tree refs) #[]
  let ctx : ExportContext := {
    file := path.toString, fileMap := inputCtx.fileMap,
    env := result.commandState.env, sourcePaths, startTime, clockMapping, references
    rawSourceClock := sourceOnly && calibrated }
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
    ("elapsedMs", toJson elapsedMs),
    ("declarations", toJson declarations),
    ("nodes", toJson exported.nodes), ("diagnostics", toJson diagnostics),
    ("success", toJson (!hasErrors)), ("thresholdMs", toJson threshold),
    ("clock", toJson clock), ("traceScope", toJson (if sourceOnly then "source" else "all")),
    ("clockCalibration", toJson clockMapping),
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
  | [input, output, threshold, mode] =>
    let some threshold := threshold.toNat?
      | throw <| IO.userError "threshold must be a nonnegative integer in milliseconds"
    SourceProfiler.run input output threshold mode
  | _ =>
    IO.eprintln "Usage: lake env lean --run SourceProfiler.lean INPUT.lean OUTPUT.json [THRESHOLD_MS]"
    return 2
