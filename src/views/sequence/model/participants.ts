/**
 * Sequence diagram participants: extracting lifelines (entry gate, instrumented
 * services, and inferred external peers) and ordering their horizontal columns
 * to minimize cross-column message distance while respecting causal left-to-right flow.
 *
 * Headless: no DOM, no browser globals.
 */

import { SpanKind, type SpanIndex } from '../../../core.ts';
import { inferredPeerOf } from '../../../core/peers.ts';

/** Kind of participant lifeline column in the sequence diagram. */
export const enum ParticipantKind {
  /** Synthetic entry gate for root/orphan spans (found messages). */
  Gate = 0,
  /** Instrumented service from resource `service.name`. */
  Service = 1,
  /** Uninstrumented external dependency inferred from leaf CLIENT/PRODUCER spans. */
  Inferred = 2,
}

/** Fallback label for leaf CLIENT/PRODUCER spans that have no cross-service child and no peer attributes. */
export const EXTERNAL_PEER_NAME = '(external)';

/** Label for the synthetic entry gate lifeline. */
export const GATE_NAME = 'Client';

/** Optional peer resolver callback signature for extracting an inferred peer from a span row. */
export type PeerResolver = (index: SpanIndex, row: number) => { readonly name: string } | null;

/** Participant lifelines and their horizontal column ordering. */
export interface Participants {
  /** Total number of participants (gate + services + inferred peers). */
  readonly count: number;
  /** Display name of each participant, indexed by participant id `0 .. count - 1`. */
  readonly names: readonly string[];
  /** `ParticipantKind` of each participant (`Gate`, `Service`, `Inferred`). */
  readonly kind: Uint8Array;
  /** Index of the gate participant, or -1 when no gate is needed. */
  readonly gateId: number;
  /** First table row associated with each participant (`0` for Gate). */
  readonly firstRow: Int32Array;
  /** Horizontal column index (`0 .. count - 1`) assigned to each participant id. */
  readonly column: Int32Array;
  /** Participant id placed at each horizontal column (`0 .. count - 1`). Inverse of `column`. */
  readonly atColumn: Int32Array;
  /** Service participant id of each `SpanTable` row (`0 <= r < table.length`). */
  readonly ofRow: Int32Array;
  /**
   * Target participant id (either a known `Service` or an `Inferred` participant) for a leaf
   * `CLIENT` or `PRODUCER` span row that has no cross-service child, or `-1` otherwise.
   */
  readonly peerOfRow: Int32Array;
}

/**
 * Extract participant lifelines (entry gate, instrumented services, and inferred peers)
 * from a `SpanIndex` and order their columns.
 */
export function buildParticipants(
  index: SpanIndex,
  peerOf: PeerResolver = inferredPeerOf,
): Participants {
  const table = index.table;
  const n = table.length;

  if (n === 0) {
    return {
      count: 0,
      names: [],
      kind: new Uint8Array(0),
      gateId: -1,
      firstRow: new Int32Array(0),
      column: new Int32Array(0),
      atColumn: new Int32Array(0),
      ofRow: new Int32Array(0),
      peerOfRow: new Int32Array(0),
    };
  }

  // 1. Determine whether a synthetic Gate participant is needed.
  let needsGate = false;
  for (let r = 0; r < n; r++) {
    if (table.parent[r] < 0) {
      const k = table.kind[r];
      if (
        k === SpanKind.Server ||
        k === SpanKind.Consumer ||
        index.ordered[r]?.parentId !== undefined
      ) {
        needsGate = true;
        break;
      }
    }
  }

  const gateId = needsGate ? 0 : -1;
  const serviceBase = needsGate ? 1 : 0;
  const serviceCount = table.services.length;

  const names: string[] = [];
  const kinds: ParticipantKind[] = [];
  const firstRowList: number[] = [];

  if (needsGate) {
    names.push(GATE_NAME);
    kinds.push(ParticipantKind.Gate);
    firstRowList.push(0);
  }

  const serviceParticipantByName = new Map<string, number>();
  for (let s = 0; s < serviceCount; s++) {
    const pId = serviceBase + s;
    const svcName = table.services[s];
    names.push(svcName);
    kinds.push(ParticipantKind.Service);
    firstRowList.push(n);
    serviceParticipantByName.set(svcName, pId);
  }

  // 2. Map each row to its service participant and record each service's first row.
  const ofRow = new Int32Array(n);
  for (let r = 0; r < n; r++) {
    const pId = serviceBase + table.svc[r];
    ofRow[r] = pId;
    if (r < firstRowList[pId]) {
      firstRowList[pId] = r;
    }
  }

  // 3. Inspect CLIENT / PRODUCER spans without cross-service descendants for inferred peers.
  const peerOfRow = new Int32Array(n).fill(-1);
  const inferredParticipantByName = new Map<string, number>();

  function internInferred(peerName: string, row: number): number {
    let infId = inferredParticipantByName.get(peerName);
    if (infId === undefined) {
      infId = names.length;
      inferredParticipantByName.set(peerName, infId);
      names.push(peerName);
      kinds.push(ParticipantKind.Inferred);
      firstRowList.push(row);
    } else if (row < firstRowList[infId]) {
      firstRowList[infId] = row;
    }
    return infId;
  }

  for (let r = 0; r < n; r++) {
    const k = table.kind[r];
    if (k !== SpanKind.Client && k !== SpanKind.Producer) continue;

    const ownSvc = table.svc[r];
    const endRow = table.subtreeEnd[r];
    let hasCrossServiceDescendant = false;
    for (let c = r + 1; c < endRow; c++) {
      if (table.svc[c] !== ownSvc) {
        hasCrossServiceDescendant = true;
        break;
      }
    }
    if (hasCrossServiceDescendant) continue;

    const peer = peerOf(index, r);
    if (peer !== null) {
      const ownName = table.services[ownSvc];
      if (peer.name === ownName) {
        peerOfRow[r] = -1;
      } else {
        const knownServiceId = serviceParticipantByName.get(peer.name);
        if (knownServiceId !== undefined) {
          peerOfRow[r] = knownServiceId;
        } else {
          peerOfRow[r] = internInferred(peer.name, r);
        }
      }
    } else if (endRow === r + 1) {
      // Leaf CLIENT/PRODUCER span with no children at all and no peer attributes.
      peerOfRow[r] = internInferred(EXTERNAL_PEER_NAME, r);
    }
  }

  const count = names.length;
  const kind = new Uint8Array(kinds);
  const firstRow = new Int32Array(firstRowList);

  // 4. Accumulate interaction weights between participants.
  // Key = caller * count + callee (directed weight; orderColumns sums both directions for distance).
  const weights = new Map<number, number>();
  function addWeight(u: number, v: number): void {
    if (u === v || u < 0 || v < 0) return;
    const key = u * count + v;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }

  for (let r = 0; r < n; r++) {
    const p = table.parent[r];
    const rowParticipant = ofRow[r];
    if (p < 0) {
      if (gateId >= 0) {
        addWeight(gateId, rowParticipant);
      }
    } else {
      const parentParticipant = ofRow[p];
      if (parentParticipant !== rowParticipant) {
        addWeight(parentParticipant, rowParticipant);
      }
    }

    const peerParticipant = peerOfRow[r];
    if (peerParticipant >= 0 && peerParticipant !== rowParticipant) {
      addWeight(rowParticipant, peerParticipant);
    }
  }

  // 5. Compute column ordering.
  const { column, atColumn } = orderColumns(count, firstRow, kind, weights, gateId);

  return {
    count,
    names,
    kind,
    gateId,
    firstRow,
    column,
    atColumn,
    ofRow,
    peerOfRow,
  };
}

/**
 * Order participant columns to minimize weighted linear arrangement distance
 * while keeping the Gate pinned at column 0 and respecting causal flow.
 *
 * @param count - Total number of participants.
 * @param firstRow - First table row of each participant (`0 .. count - 1`).
 * @param kind - `ParticipantKind` of each participant (`0 .. count - 1`).
 * @param weights - Interaction weights keyed by `a * count + b` (directed or undirected).
 * @param gateId - Gate participant id, or `-1` when no gate exists.
 */
export function orderColumns(
  count: number,
  firstRow: Int32Array,
  kind: Uint8Array,
  weights: ReadonlyMap<number, number>,
  gateId: number,
): { readonly column: Int32Array; readonly atColumn: Int32Array } {
  const column = new Int32Array(count);
  const atColumn = new Int32Array(count);

  if (count === 0) {
    return { column, atColumn };
  }

  // 1. Seed `atColumn` with Gate at column 0 (if present), then ascending `firstRow[p]`, tie-broken by `p`.
  const initialOrder: number[] = [];
  for (let p = 0; p < count; p++) {
    if (p !== gateId) initialOrder.push(p);
  }
  initialOrder.sort((a, b) => firstRow[a] - firstRow[b] || a - b);

  let writeIdx = 0;
  if (gateId >= 0 && gateId < count) {
    atColumn[writeIdx++] = gateId;
  }
  for (let i = 0; i < initialOrder.length; i++) {
    atColumn[writeIdx++] = initialOrder[i];
  }

  for (let c = 0; c < count; c++) {
    column[atColumn[c]] = c;
  }

  if (count <= 2 && gateId >= 0) {
    return { column, atColumn };
  }

  // Precompute symmetric undirected weight w(u, v) and directed weight d(u, v).
  const symWeight = new Float64Array(count * count);
  const dirWeight = new Float64Array(count * count);
  for (let u = 0; u < count; u++) {
    for (let v = 0; v < count; v++) {
      if (u === v) continue;
      const dUV = weights.get(u * count + v) ?? 0;
      const dVU = weights.get(v * count + u) ?? 0;
      dirWeight[u * count + v] = dUV;
      symWeight[u * count + v] = dUV + dVU;
    }
  }

  // For each Inferred participant, find its heaviest caller participant id (or -1).
  const heaviestCaller = new Int32Array(count).fill(-1);
  for (let p = 0; p < count; p++) {
    if (kind[p] !== ParticipantKind.Inferred) continue;
    let bestCaller = -1;
    let bestWeight = 0;
    for (let u = 0; u < count; u++) {
      if (u === p) continue;
      const w = symWeight[u * count + p];
      if (
        w > bestWeight ||
        (w > 0 && w === bestWeight && bestCaller >= 0 && (firstRow[u] < firstRow[bestCaller] || (firstRow[u] === firstRow[bestCaller] && u < bestCaller)))
      ) {
        bestWeight = w;
        bestCaller = u;
      }
    }
    heaviestCaller[p] = bestCaller;
  }

  const startCol = gateId >= 0 ? 1 : 0;

  function evaluateArrangement(): {
    cost: number;
    inferredAdjacent: number;
    rightwardFlow: number;
  } {
    let cost = 0;
    let rightwardFlow = 0;
    let inferredAdjacent = 0;

    for (let i = 0; i < count; i++) {
      const u = atColumn[i];
      if (i > 0 && kind[u] === ParticipantKind.Inferred && heaviestCaller[u] === atColumn[i - 1]) {
        inferredAdjacent++;
      }
      for (let j = i + 1; j < count; j++) {
        const v = atColumn[j];
        const w = symWeight[u * count + v];
        if (w > 0) {
          cost += w * (j - i);
        }
        const d = dirWeight[u * count + v];
        if (d > 0) {
          rightwardFlow += d;
        }
      }
    }
    return { cost, inferredAdjacent, rightwardFlow };
  }

  // 2. Run up to 8 passes of adjacent-swap refinement on non-gate positions.
  let current = evaluateArrangement();

  for (let pass = 0; pass < 8; pass++) {
    let swapped = false;
    // Sweep right-to-left on even passes so a distant callee moves left to meet its earlier caller
    // rather than pulling the earlier caller right past intermediate participants; alternate on odd passes.
    const reverse = pass % 2 === 0;
    const begin = reverse ? count - 2 : startCol;
    const end = reverse ? startCol - 1 : count - 1;
    const step = reverse ? -1 : 1;

    for (let c = begin; c !== end; c += step) {
      const u = atColumn[c];
      const v = atColumn[c + 1];
      atColumn[c] = v;
      atColumn[c + 1] = u;

      const candidate = evaluateArrangement();
      const improvesCost = candidate.cost < current.cost;
      const tiesCostAndImprovesSecondary =
        candidate.cost === current.cost &&
        (candidate.inferredAdjacent > current.inferredAdjacent ||
          (candidate.inferredAdjacent === current.inferredAdjacent &&
            candidate.rightwardFlow > current.rightwardFlow));

      if (improvesCost || tiesCostAndImprovesSecondary) {
        current = candidate;
        swapped = true;
      } else {
        // Revert swap
        atColumn[c] = u;
        atColumn[c + 1] = v;
      }
    }

    if (!swapped) break;
  }

  // 3. Build `column` as the inverse permutation (`column[atColumn[c]] = c`).
  for (let c = 0; c < count; c++) {
    column[atColumn[c]] = c;
  }

  return { column, atColumn };
}
