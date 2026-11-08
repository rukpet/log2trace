/**
 * Sequence diagram static message classification per span row.
 *
 * Headless: no DOM, no browser globals.
 */

import { Slice, SpanKind, defineSelector, type Selector, type SpanIndex } from '../../../core.ts';
import { buildParticipants, ParticipantKind, type Participants } from './participants.ts';

/** How a `SpanTable` row participates in the sequence diagram. */
export const enum MsgKind {
  /** Suppressed caller-side CLIENT/PRODUCER span that was merged as the `via` of a cross-service child. */
  None = 0,
  /** Root or orphan span entering from the synthetic Gate (`Gate -> ofRow[r]`) or starting at `ofRow[r]`. */
  Found = 1,
  /** Synchronous cross-service call (`ofRow[parent] -> ofRow[r]`). */
  Sync = 2,
  /** Asynchronous cross-service message (`PRODUCER` or `CONSUMER`). */
  Async = 3,
  /** Same-service RPC boundary (`parent` is `CLIENT`/`PRODUCER` and `r` is `SERVER`/`CONSUMER` in same service). */
  SelfRpc = 4,
  /** Leaf `CLIENT`/`PRODUCER` span calling an inferred or uninstrumented peer (`ofRow[r] -> peerOfRow[r]`). */
  Peer = 5,
  /** Internal span within the same service (shown when internal mode is `'show'`, hidden when `'hide'`). */
  Internal = 6,
}

/** Static sequence topology derived once per `SpanIndex`. */
export interface SequenceModel {
  readonly index: SpanIndex;
  readonly participants: Participants;
  /** `MsgKind` classification for each `SpanTable` row (`0 .. table.length - 1`). */
  readonly msgKind: Uint8Array;
  /** Source participant id for each row (`-1` if `MsgKind.None` or root with no gate). */
  readonly from: Int32Array;
  /** Target participant id for each row (`ofRow[r]`, or `peerOfRow[r]` when `MsgKind.Peer`). */
  readonly to: Int32Array;
  /** Caller-side `CLIENT`/`PRODUCER` table row merged into this message, or `-1`. */
  readonly via: Int32Array;
  /** `1` if the root span had a `parentSpanId` that was not present in the trace (orphan). */
  readonly orphan: Uint8Array;
  /** `1` if the span has clock skew relative to its parent/via (`start[r] < start[parent]` or `end[r] < start[r]`). */
  readonly skew: Uint8Array;
  /** `1` if the span overlaps in time with a sibling message under the same effective caller. */
  readonly parallel: Uint8Array;
  /** True when the trace has at most 1 non-gate participant (so `internal='auto'` defaults to `'show'`). */
  readonly singleParticipant: boolean;
}

export function buildSequenceModel(index: SpanIndex): SequenceModel {
  const participants = buildParticipants(index);
  const table = index.table;
  const n = table.length;

  const msgKind = new Uint8Array(n);
  const from = new Int32Array(n).fill(-1);
  const to = new Int32Array(n).fill(-1);
  const via = new Int32Array(n).fill(-1);
  const orphan = new Uint8Array(n);
  const skew = new Uint8Array(n);
  const parallel = new Uint8Array(n);

  // 1. Classify each SpanTable row and detect clock skew.
  for (let r = 0; r < n; r++) {
    const k = table.kind[r];
    const rowParticipant = participants.ofRow[r];

    // Check if CLIENT/PRODUCER acts as a caller-side `via` wrapper for a direct child.
    if (k === SpanKind.Client || k === SpanKind.Producer) {
      let hasMergedChild = false;
      const subEnd = table.subtreeEnd[r];
      for (let c = r + 1; c < subEnd; c = table.subtreeEnd[c]) {
        const childParticipant = participants.ofRow[c];
        const childKind = table.kind[c];
        if (
          childParticipant !== rowParticipant ||
          childKind === SpanKind.Server ||
          childKind === SpanKind.Consumer
        ) {
          hasMergedChild = true;
          break;
        }
      }
      if (hasMergedChild) {
        msgKind[r] = MsgKind.None;
        from[r] = -1;
        to[r] = rowParticipant;
        via[r] = -1;
        if (table.end[r] < table.start[r]) {
          skew[r] = 1;
        }
        continue;
      }
    }

    const p = table.parent[r];
    if (p < 0) {
      // Case 1: Root span
      msgKind[r] = MsgKind.Found;
      from[r] = participants.gateId >= 0 ? participants.gateId : rowParticipant;
      to[r] = rowParticipant;
      via[r] = -1;
      orphan[r] = index.ordered[r]?.parentId !== undefined ? 1 : 0;
    } else if (participants.ofRow[p] !== rowParticipant) {
      // Case 2: Cross-service call
      const pKind = table.kind[p];
      via[r] = pKind === SpanKind.Client || pKind === SpanKind.Producer ? p : -1;
      const isAsync =
        k === SpanKind.Consumer || pKind === SpanKind.Producer || k === SpanKind.Producer;
      msgKind[r] = isAsync ? MsgKind.Async : MsgKind.Sync;
      from[r] = participants.ofRow[p];
      to[r] = rowParticipant;
    } else if (
      (table.kind[p] === SpanKind.Client || table.kind[p] === SpanKind.Producer) &&
      (k === SpanKind.Server || k === SpanKind.Consumer)
    ) {
      // Case 3: Same-service RPC boundary
      via[r] = p;
      msgKind[r] =
        table.kind[p] === SpanKind.Producer || k === SpanKind.Consumer
          ? MsgKind.Async
          : MsgKind.SelfRpc;
      from[r] = participants.ofRow[p];
      to[r] = rowParticipant;
    } else if (participants.peerOfRow[r] >= 0) {
      // Case 4: Leaf CLIENT/PRODUCER with inferred or known peer
      msgKind[r] = k === SpanKind.Producer ? MsgKind.Async : MsgKind.Peer;
      from[r] = rowParticipant;
      to[r] = participants.peerOfRow[r];
      via[r] = -1;
    } else {
      // Case 5: Internal span within the same service
      msgKind[r] = MsgKind.Internal;
      from[r] = rowParticipant;
      to[r] = rowParticipant;
      via[r] = -1;
    }

    // Clock skew detection
    const startR = table.start[r];
    const endR = table.end[r];
    const isAsyncMsg = msgKind[r] === MsgKind.Async;
    const viaRow = via[r];
    if (
      endR < startR ||
      (viaRow >= 0 &&
        (startR < table.start[viaRow] || (!isAsyncMsg && endR > table.end[viaRow]))) ||
      (p >= 0 && (startR < table.start[p] || (!isAsyncMsg && endR > table.end[p])))
    ) {
      skew[r] = 1;
    }
  }

  // 2. Parallel sibling detection grouped by effective caller row.
  const siblingsByCaller = new Map<number, number[]>();
  for (let r = 0; r < n; r++) {
    if (msgKind[r] === MsgKind.None) continue;
    const viaRow = via[r];
    const caller = viaRow >= 0 ? table.parent[viaRow] : table.parent[r];
    if (caller < 0) continue;
    const group = siblingsByCaller.get(caller);
    if (group !== undefined) {
      group.push(r);
    } else {
      siblingsByCaller.set(caller, [r]);
    }
  }

  for (const siblings of siblingsByCaller.values()) {
    const len = siblings.length;
    if (len < 2) continue;
    for (let i = 0; i < len; i++) {
      const a = siblings[i];
      const viaA = via[a];
      for (let j = i + 1; j < len; j++) {
        const b = siblings[j];
        const viaB = via[b];
        const useViaA =
          viaA >= 0 &&
          viaA !== viaB &&
          table.start[viaA] <= table.start[a] &&
          table.end[viaA] >= table.end[a];
        const useViaB =
          viaB >= 0 &&
          viaB !== viaA &&
          table.start[viaB] <= table.start[b] &&
          table.end[viaB] >= table.end[b];

        const rawStartA = useViaA ? table.start[viaA] : table.start[a];
        const rawEndA = useViaA ? table.end[viaA] : table.end[a];
        const startA = Math.min(rawStartA, rawEndA);
        const endA = Math.max(rawStartA, rawEndA);

        const rawStartB = useViaB ? table.start[viaB] : table.start[b];
        const rawEndB = useViaB ? table.end[viaB] : table.end[b];
        const startB = Math.min(rawStartB, rawEndB);
        const endB = Math.max(rawStartB, rawEndB);

        if (Math.max(startA, startB) < Math.min(endA, endB)) {
          parallel[a] = 1;
          parallel[b] = 1;
        }
      }
    }
  }

  // 3. Count non-gate participants for singleParticipant.
  let nonGateCount = 0;
  for (let p = 0; p < participants.count; p++) {
    if (participants.kind[p] !== ParticipantKind.Gate) {
      nonGateCount++;
    }
  }

  return {
    index,
    participants,
    msgKind,
    from,
    to,
    via,
    orphan,
    skew,
    parallel,
    singleParticipant: nonGateCount <= 1,
  };
}

export const sequenceModel: Selector<SequenceModel> = defineSelector(
  'sequence.model',
  Slice.Data,
  (state, previous) =>
    previous !== undefined && previous.index === state.data.index
      ? previous
      : buildSequenceModel(state.data.index),
);
