/**
 * Sequence diagram selection/hover span resolution and tooltip InfoModel builders.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  SpanKind,
  describeSpan,
  formatDuration,
  formatOffset,
  spanKindName,
  type InfoModel,
  type InfoRow,
  type InfoSection,
  type SpanId,
} from '../../../core.ts';
import { ParticipantKind } from './participants.ts';
import { MsgKind, type SequenceModel } from './messages.ts';
import { StepFlag, StepKind, type SequenceSteps } from './steps.ts';

/**
 * Return the span IDs and primary span ID for selecting/hovering a step row.
 * - For a normal step (`Call`, `Return`, `Async`, `SelfCall`, `Found`): includes `ids[row]` and, if `via >= 0`, `ids[via]`; `primary` is `ids[row]`; `key` is `"msg:" + row`.
 * - For a `Fold` step: includes `ids[r]` (and `ids[via[r]]` when `via[r] >= 0`) for every row in `foldRows[foldRowOff[step] .. foldRowOff[step + 1] - 1]`; `primary` is the first failing folded row or the longest-duration folded row; `key` is `"fold:" + row`.
 * - For an `Elided` step: returns empty `ids: []`, `primary: null`, `key: "elided:" + row`.
 */
export function spansOfStep(
  steps: SequenceSteps,
  step: number,
): { readonly ids: SpanId[]; readonly primary: SpanId | null; readonly key: string } {
  if (step < 0 || step >= steps.count) {
    return { ids: [], primary: null, key: '' };
  }

  const { model } = steps;
  const { table } = model.index;
  const r = steps.row[step];
  const kind = steps.kind[step];

  if (kind === StepKind.Elided) {
    return { ids: [], primary: null, key: `elided:${r}` };
  }

  if (kind === StepKind.Fold) {
    const ids: SpanId[] = [];
    const startOff = steps.foldRowOff[step];
    const endOff = steps.foldRowOff[step + 1];

    let firstFailing: SpanId | null = null;
    let longest: SpanId | null = null;
    let maxDur = -1;

    if (endOff > startOff) {
      for (let i = startOff; i < endOff; i++) {
        const fr = steps.foldRows[i];
        const id = table.ids[fr];
        ids.push(id);
        const fv = model.via[fr];
        if (fv >= 0) {
          ids.push(table.ids[fv]);
        }

        const isErr = table.status[fr] === 2 || (fv >= 0 && table.status[fv] === 2);
        if (isErr && firstFailing === null) {
          firstFailing = id;
        }
        const dur = table.end[fr] - table.start[fr];
        if (dur > maxDur) {
          maxDur = dur;
          longest = id;
        }
      }
    } else if (r >= 0 && r < table.length) {
      const id = table.ids[r];
      ids.push(id);
      const v = steps.via[step];
      if (v >= 0) {
        ids.push(table.ids[v]);
      }
      longest = id;
    }

    const primary = firstFailing ?? longest ?? (ids.length > 0 ? ids[0] : null);
    return { ids: [...new Set(ids)], primary, key: `fold:${r}` };
  }

  const ids: SpanId[] = [];
  let primary: SpanId | null = null;
  if (r >= 0 && r < table.length) {
    primary = table.ids[r];
    ids.push(primary);
  }
  const v = steps.via[step];
  if (v >= 0 && v < table.length) {
    const viaId = table.ids[v];
    if (viaId !== primary) {
      ids.push(viaId);
    }
  }

  return { ids, primary, key: `msg:${r}` };
}

/**
 * Return the span IDs and primary span ID for selecting/hovering an activation bar.
 * Includes `ids[act.row[actIdx]]` (and `ids[via]` if `via >= 0`), `primary = ids[act.row[actIdx]]`, `key = "act:" + act.row[actIdx]`.
 */
export function spansOfActivation(
  steps: SequenceSteps,
  actIdx: number,
): { readonly ids: SpanId[]; readonly primary: SpanId | null; readonly key: string } {
  if (actIdx < 0 || actIdx >= steps.act.count) {
    return { ids: [], primary: null, key: '' };
  }

  const { model } = steps;
  const { table } = model.index;
  const r = steps.act.row[actIdx];
  if (r < 0 || r >= table.length) {
    return { ids: [], primary: null, key: `act:${r}` };
  }

  const primary = table.ids[r];
  const ids: SpanId[] = [primary];
  const v = model.via[r];
  if (v >= 0 && v < table.length) {
    const viaId = table.ids[v];
    if (viaId !== primary) {
      ids.push(viaId);
    }
  }

  return { ids, primary, key: `act:${r}` };
}

/**
 * Return all span IDs belonging to a participant column (`ofRow[r] === partIdx || peerOfRow[r] === partIdx`),
 * picking the first failing entry span, or first failing span, or longest span as `primary`, with `key = "p:" + partIdx`.
 * For the synthetic `Gate` participant, includes all root spans that originate from the Gate.
 */
export function spansOfParticipant(
  model: SequenceModel,
  partIdx: number,
): { readonly ids: SpanId[]; readonly primary: SpanId | null; readonly key: string } {
  const { participants, index } = model;
  if (partIdx < 0 || partIdx >= participants.count) {
    return { ids: [], primary: null, key: '' };
  }

  const { table } = index;
  const ids: SpanId[] = [];
  let firstFailingEntry: SpanId | null = null;
  let firstFailingAny: SpanId | null = null;
  let longestSpan: SpanId | null = null;
  let maxDuration = -1;

  const isGate = participants.kind[partIdx] === ParticipantKind.Gate;

  for (let r = 0; r < table.length; r++) {
    let belongs = false;
    let isEntry = false;

    if (isGate) {
      const fromGate =
        model.from[r] === partIdx ||
        model.msgKind[r] === MsgKind.Found ||
        (model.from[r] < 0 &&
          table.parent[r] < 0 &&
          (table.kind[r] === SpanKind.Server ||
            table.kind[r] === SpanKind.Consumer ||
            index.ordered[r]?.parentId !== undefined));
      if (fromGate) {
        belongs = true;
        isEntry = true;
      }
    } else if (participants.ofRow[r] === partIdx) {
      belongs = true;
      const p = table.parent[r];
      isEntry = p < 0 || participants.ofRow[p] !== partIdx;
    } else if (participants.peerOfRow[r] === partIdx) {
      belongs = true;
      isEntry = true;
    }

    if (belongs) {
      const id = table.ids[r];
      ids.push(id);
      const dur = table.end[r] - table.start[r];
      if (table.status[r] === 2) {
        firstFailingAny ??= id;
        if (isEntry) {
          firstFailingEntry ??= id;
        }
      }
      if (dur > maxDuration) {
        maxDuration = dur;
        longestSpan = id;
      }
    }
  }

  const primary = firstFailingEntry ?? firstFailingAny ?? longestSpan ?? (ids.length > 0 ? ids[0] : null);
  return { ids, primary, key: `p:${partIdx}` };
}

function stepPatternLabel(kind: number): string {
  switch (kind) {
    case StepKind.Call:
      return 'Synchronous RPC';
    case StepKind.Return:
      return 'Return';
    case StepKind.Async:
      return 'Asynchronous Message';
    case StepKind.SelfCall:
      return 'Self Call';
    case StepKind.Found:
      return 'Entry Request';
    default:
      return 'Interaction';
  }
}

/**
 * Build an `InfoModel` for a step tooltip (`StepKind.Call`, `Return`, `Async`, `SelfCall`, `Found`, `Fold`, `Elided`).
 */
export function describeStep(steps: SequenceSteps, step: number): InfoModel | null {
  if (step < 0 || step >= steps.count) {
    return null;
  }

  const { model } = steps;
  const { index, participants } = model;
  const { table } = index;

  const kind = steps.kind[step];
  const flags = steps.flags[step];
  const r = steps.row[step];
  const v = steps.via[step];
  const fromId = steps.from[step];
  const toId = steps.to[step];

  const fromName = fromId >= 0 && fromId < participants.count ? participants.names[fromId] : 'Unknown';
  const toName = toId >= 0 && toId < participants.count ? participants.names[toId] : 'Unknown';

  if (kind === StepKind.Fold) {
    const indexed = index.ordered[r];
    const spanName = indexed ? indexed.span.name : '';
    const foldCount = steps.foldCount[step];
    const totalDur = steps.duration[step];
    const foldMaxDur = steps.foldMaxDuration[step];
    const foldErrors = steps.foldErrors[step];

    const rows: InfoRow[] = [
      ['Calls', String(foldCount)],
      ['Total Duration', formatDuration(totalDur)],
      ['Avg Duration', formatDuration(foldCount > 0 ? totalDur / foldCount : 0)],
      ['Max Duration', formatDuration(foldMaxDur)],
      ...(foldErrors > 0 ? ([['Errors', String(foldErrors)]] as InfoRow[]) : []),
    ];

    return {
      title: `${spanName} (×${foldCount})`,
      subtitle: `${fromName} → ${toName}`,
      status: foldErrors > 0 ? 'error' : 'ok',
      sections: [{ title: 'Repeated Call Loop', rows }],
    };
  }

  if (kind === StepKind.Elided) {
    const foldCount = steps.foldCount[step];
    return {
      title: `${foldCount} elided interactions`,
      subtitle: 'Outside active time window',
      status: 'unset',
      sections: [
        {
          title: 'Time Window',
          rows: [
            ['Elided Spans', String(foldCount)],
            ['Span Range', formatDuration(steps.duration[step])],
          ],
        },
      ],
    };
  }

  const indexed = index.ordered[r];
  if (!indexed) {
    return null;
  }

  const viaSpan = v >= 0 ? index.ordered[v] : undefined;
  const subtitle =
    kind === StepKind.Return ? `${fromName} ⇢ ${toName} (return)` : `${fromName} → ${toName}`;
  const status =
    (flags & StepFlag.Error) !== 0 ? 'error' : table.status[r] === 1 ? 'ok' : 'unset';

  const rows: InfoRow[] = [
    ['Caller → Callee', `${fromName} → ${toName}`],
    ['Pattern', stepPatternLabel(kind)],
    ['Start Offset', formatOffset(steps.time[step])],
    ['Duration', formatDuration(steps.duration[step])],
  ];

  if (v >= 0 && viaSpan !== undefined) {
    const clientDur = Math.max(0, table.end[v] - table.start[v]);
    rows.push(['Client Span', `${viaSpan.span.name} (${formatDuration(clientDur)})`]);
    rows.push(['Transit Delay', formatDuration(table.start[r] - table.start[v])]);
  }

  if ((flags & StepFlag.Skew) !== 0) {
    rows.push(['Clock Skew', 'Detected (child outside parent bounds)']);
  }

  if ((flags & StepFlag.Orphan) !== 0) {
    rows.push(['Orphan Span', `Missing parent ${indexed.parentId ?? ''}`]);
  }

  if (indexed.span.status?.message) {
    rows.push(['Status Message', indexed.span.status.message]);
  }

  return {
    title: indexed.span.name,
    subtitle,
    status,
    sections: [{ title: 'Interaction', rows }],
  };
}

/**
 * Build an `InfoModel` for an activation bar tooltip.
 */
export function describeActivation(steps: SequenceSteps, actIdx: number): InfoModel | null {
  if (actIdx < 0 || actIdx >= steps.act.count) {
    return null;
  }

  const { model, act } = steps;
  const { index, participants } = model;
  const r = act.row[actIdx];
  const indexed = index.ordered[r];
  if (!indexed) {
    return null;
  }

  const base = describeSpan(index, indexed.spanId, 'brief');
  const partIdx = act.part[actIdx];
  const partName =
    partIdx >= 0 && partIdx < participants.count
      ? participants.names[partIdx]
      : indexed.serviceName;
  const nest = act.nest[actIdx];
  const hiddenCount = act.hiddenCount[actIdx];

  const baseRows = base?.sections[0]?.rows ?? [
    ['Duration', formatDuration(index.table.end[r] - index.table.start[r])],
    ['Kind', spanKindName(indexed.span.kind) || 'Unknown'],
    ['Span ID', indexed.spanId],
  ];

  const rows: InfoRow[] = [...baseRows];
  if (nest > 0) {
    rows.push(['Nesting Level', String(nest)]);
  }
  if (hiddenCount > 0) {
    rows.push(['Hidden Spans', String(hiddenCount)]);
  }

  return {
    title: indexed.span.name,
    subtitle: partName,
    status: base?.status ?? 'unset',
    sections: [{ title: 'Overview', rows }],
  };
}

/**
 * Build an `InfoModel` for a lifeline header card tooltip.
 */
export function describeParticipant(model: SequenceModel, partIdx: number): InfoModel | null {
  const { participants, index } = model;
  if (partIdx < 0 || partIdx >= participants.count) {
    return null;
  }

  const { table } = index;
  const kind = participants.kind[partIdx];

  let incomingCalls = 0;
  let outgoingCalls = 0;
  let spanCount = 0;
  let errors = 0;

  for (let r = 0; r < table.length; r++) {
    if (model.to[r] === partIdx) {
      incomingCalls++;
    }
    if (model.from[r] === partIdx) {
      outgoingCalls++;
    }
    if (participants.ofRow[r] === partIdx || participants.peerOfRow[r] === partIdx) {
      spanCount++;
      if (table.status[r] === 2) {
        errors++;
      }
    }
  }

  const rows: InfoRow[] = [
    ['Incoming Calls', String(incomingCalls)],
    ['Outgoing Calls', String(outgoingCalls)],
    ['Spans', String(spanCount)],
    ['Errors', String(errors)],
  ];

  const subtitle =
    kind === ParticipantKind.Gate
      ? 'Entry Point'
      : kind === ParticipantKind.Inferred
        ? 'Inferred Dependency'
        : 'Service';

  const sections: InfoSection[] = [{ title: 'Lifeline', rows }];

  return {
    title: participants.names[partIdx],
    subtitle,
    status: errors > 0 ? 'error' : 'ok',
    sections,
  };
}
