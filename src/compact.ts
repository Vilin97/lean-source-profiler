/** Expand the disk representation only when a viewer/query needs individual events. */
export function expandCompact(input: Record<string, unknown>): Record<string, unknown> {
  const invalid = (): never => { throw new Error('Invalid Lean profile: malformed compact event tables'); };
  const { events, classes, ranges } = input;
  if (input.kind !== 'lean-source-profile-compact' || !Array.isArray(events) || events.length > 3_000_000 ||
    !Array.isArray(classes) || !Array.isArray(ranges)) invalid();
  const table = classes as unknown[], positions = ranges as unknown[];
  for (const c of table) if (!Array.isArray(c) || c.length !== 2 || c.some(x => typeof x !== 'string')) invalid();
  for (const r of positions) if (!Array.isArray(r) || r.length !== 4 ||
    r.some(x => !Number.isSafeInteger(x) || x < 0)) invalid();
  const nodes = (events as unknown[]).map((raw, id) => {
    if (!Array.isArray(raw) || raw.length !== 7) invalid();
    const [parent, category, startMs, durationMs, thread, range, kind] = raw as unknown[];
    if (!Number.isSafeInteger(parent) || (parent as number) < -1 || (parent as number) >= id ||
      !Number.isSafeInteger(category) || (category as number) < 0 || (category as number) >= table.length ||
      !Number.isSafeInteger(range) || (range as number) < -1 || (range as number) >= positions.length ||
      ![0, 1, 2].includes(kind as number) || ((range === -1) !== (kind === 0)) || typeof thread !== 'string') invalid();
    const [name, label] = table[category as number] as string[];
    const r = range === -1 ? undefined : positions[range as number] as number[];
    return { id: String(id), parentId: parent === -1 ? null : String(parent), category: name, label,
      detail: '', startMs, durationMs, thread,
      source: r ? { file: input.sourceFile, start: { line: r[0], character: r[1] }, end: { line: r[2], character: r[3] } } : undefined,
      sourceKind: kind === 1 ? 'exact' : kind === 2 ? 'inherited' : undefined };
  });
  return { ...input, schemaVersion: 1, nodes, captureMode: 'compact',
    captureMethod: 'structured-elaborator-wrappers-compact' };
}
