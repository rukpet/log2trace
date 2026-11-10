/**
 * The service graph model: extracting service topology, aggregating metrics,
 * and laying out nodes and directed edges in a layered hierarchical DAG.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  Slice,
  SpanKind,
  defineSelector,
  formatDuration,
  type InfoModel,
  type InfoRow,
  type InfoSection,
  type Selector,
  type SpanId,
  type SpanIndex,
  type SpanMask,
  type SpanSet,
  type TimeWindow,
} from '../../core.ts';
import { inferredPeerOf } from '../../core/peers.ts';

/** Kind of node in the service graph. */
export const enum NodeKind {
  /** An instrumented service with its own spans. */
  Service = 0,
  /** An uninstrumented peer dependency (DB, cache, external RPC) inferred from client spans. */
  Inferred = 1,
}

/** Communication pattern of an edge. */
export const enum EdgePattern {
  /** Synchronous RPC/HTTP call (Client -> Server). */
  Sync = 1,
  /** Asynchronous messaging (Producer -> Consumer or Span.links). */
  Async = 2,
  /** Mixture of sync and async calls between the two services. */
  Mixed = 3,
}

/** Node card dimensions and layout constants (in world pixels). */
export const NODE_WIDTH = 192;
export const NODE_HEIGHT = 68;
export const RANK_GAP_X = 110;
export const NODE_GAP_Y = 28;
export const GRAPH_PAD = 40;

/** Static topology and layout of the service graph, cached per trace. */
export interface ServiceTopology {
  readonly index: SpanIndex;
  /** Total number of nodes (services + inferred dependencies). */
  readonly nodeCount: number;
  /** Distinct node names. */
  readonly names: readonly string[];
  /** NodeKind for each node: 0 for Service, 1 for Inferred. */
  readonly nodeKind: Uint8Array;
  /** The first SpanTable row associated with each node (for stable ordering). */
  readonly firstRowOfNode: Int32Array;
  /** 1 if the node is an external root/entrypoint. */
  readonly isEntryNode: Uint8Array;
  /** Node index of each SpanTable row (`0 <= r < table.length`). */
  readonly nodeOfRow: Int32Array;
  /** Inferred target node index called by leaf span `r`, or -1. */
  readonly inferredTargetOfRow: Int32Array;
  /** 1 if table row `r` is a service entry span into its service. */
  readonly isEntryRow: Uint8Array;

  /** Total number of unique directed edges (aggregated by source and target). */
  readonly edgeCount: number;
  /** Source node index of each edge. */
  readonly source: Int32Array;
  /** Target node index of each edge. */
  readonly target: Int32Array;
  /** Edge pattern (Sync, Async, Mixed). */
  readonly pattern: Uint8Array;
  /** 1 if the edge is a self-loop (source === target). */
  readonly isSelfLoop: Uint8Array;
  /** 1 if the edge was reversed during DAG ranking to break a causal cycle. */
  readonly reversed: Uint8Array;

  /** Edge index for each incoming cross-service transition row `r`, or -1 (primary transition). */
  readonly edgeOfRow: Int32Array;
  /** All edge indices associated with table row `r` as callee/producer transition. */
  readonly edgesOfRow: readonly (readonly number[] | undefined)[];
  /** Transition callee rows per edge: edgeRows[edgeRowOff[e] … edgeRowOff[e+1]-1]. */
  readonly edgeRowOff: Int32Array;
  readonly edgeRows: Int32Array;

  /** Overall layout width in world px. */
  readonly width: number;
  /** Overall layout height in world px. */
  readonly height: number;
  /** Rank (column) assigned to each node. */
  readonly rank: Int32Array;
  /** World X position of top-left corner of each node card. */
  readonly nodeX: Float64Array;
  /** World Y position of top-left corner of each node card. */
  readonly nodeY: Float64Array;
  /** SVG path definition (`d`) for each edge. */
  readonly edgePath: readonly string[];
  /** World X position for edge midpoint pill badge. */
  readonly labelX: Float64Array;
  /** World Y position for edge midpoint pill badge. */
  readonly labelY: Float64Array;
}

/** Windowed metrics calculated over the static topology. */
export interface ServiceGraph {
  readonly topology: ServiceTopology;
  readonly window: TimeWindow | null;
  /** Total self-time across all services in the trace, ms. */
  readonly totalSelfMs: number;

  // Per-node windowed metrics (length = topology.nodeCount)
  /** Count of spans within this service overlapping the window. */
  readonly spanCount: Int32Array;
  /** Count of entry requests into this service overlapping the window. */
  readonly requestCount: Int32Array;
  /** Count of failing spans (status === 2) overlapping the window. */
  readonly errorCount: Int32Array;
  /** Non-overlapping self-execution time, ms. */
  readonly selfMs: Float64Array;
  /** Sum of entry request durations, ms. */
  readonly totalMs: Float64Array;
  /** 95th percentile entry duration, ms. */
  readonly p95Ms: Float64Array;
  /** Max entry duration, ms. */
  readonly maxMs: Float64Array;

  // Per-edge windowed metrics (length = topology.edgeCount)
  /** Call count across this edge overlapping the window. */
  readonly callCount: Int32Array;
  /** Count of failed calls (callee or caller status === 2). */
  readonly edgeErrorCount: Int32Array;
  /** Sum of transition durations, ms. */
  readonly edgeTotalMs: Float64Array;
  /** Average transition duration, ms. */
  readonly edgeAvgMs: Float64Array;
  /** 95th percentile transition duration, ms. */
  readonly edgeP95Ms: Float64Array;
  /** Max transition duration, ms. */
  readonly edgeMaxMs: Float64Array;
}

// -----------------------------------------------------------------------------
// Topology Extraction
// -----------------------------------------------------------------------------

/** Extract the topology of services and build the layout. */
export function buildServiceTopology(index: SpanIndex): ServiceTopology {
  const t = index.table;
  const n = t.length;
  const serviceCount = t.services.length;

  const nodeNames: string[] = [...t.services];
  const serviceIndexByName = new Map<string, number>();
  for (let s = 0; s < serviceCount; s++) serviceIndexByName.set(t.services[s], s);
  const inferredMap = new Map<string, number>();
  // Target node (service or inferred) for leaf Client/Producer spans
  const clientTargetOfRow = new Int32Array(n).fill(-1);
  const inferredTargetOfRow = new Int32Array(n).fill(-1);

  // Identify inferred peer dependencies or cross-service targets from leaf Client/Producer spans
  for (let r = 0; r < n; r++) {
    const k = t.kind[r];
    // Client (3) or Producer (4)
    if (k === SpanKind.Client || k === SpanKind.Producer) {
      // Check if it has any cross-service child spans
      let hasCrossServiceChild = false;
      const endRow = t.subtreeEnd[r];
      for (let c = r + 1; c < endRow; c++) {
        if (t.svc[c] !== t.svc[r]) {
          hasCrossServiceChild = true;
          break;
        }
      }
      if (!hasCrossServiceChild) {
        const peer = inferredPeerOf(index, r);
        if (peer !== null && peer.name !== t.services[t.svc[r]]) {
          const knownServiceIdx = serviceIndexByName.get(peer.name);
          if (knownServiceIdx !== undefined) {
            clientTargetOfRow[r] = knownServiceIdx;
          } else {
            let infIdx = inferredMap.get(peer.name);
            if (infIdx === undefined) {
              infIdx = nodeNames.length;
              inferredMap.set(peer.name, infIdx);
              nodeNames.push(peer.name);
            }
            clientTargetOfRow[r] = infIdx;
            inferredTargetOfRow[r] = infIdx;
          }
        }
      }
    }
  }

  const nodeCount = nodeNames.length;
  const nodeKind = new Uint8Array(nodeCount);
  for (let u = serviceCount; u < nodeCount; u++) nodeKind[u] = NodeKind.Inferred;

  const nodeOfRow = new Int32Array(n);
  const isEntryRow = new Uint8Array(n);
  const firstRowOfNode = new Int32Array(nodeCount).fill(n);
  const isEntryNode = new Uint8Array(nodeCount);

  for (let r = 0; r < n; r++) {
    const s = t.svc[r];
    nodeOfRow[r] = s;
    if (r < firstRowOfNode[s]) firstRowOfNode[s] = r;

    const p = t.parent[r];
    if (p < 0 || t.svc[p] !== s) {
      isEntryRow[r] = 1;
      if (p < 0) isEntryNode[s] = 1;
    }
  }

  for (let r = 0; r < n; r++) {
    const inf = inferredTargetOfRow[r];
    if (inf >= 0 && r < firstRowOfNode[inf]) firstRowOfNode[inf] = r;
  }

  // Detect cross-service edges: parent-child, inferred peers, and span links
  interface RawTransition {
    readonly source: number;
    readonly target: number;
    readonly calleeRow: number;
    readonly pattern: EdgePattern;
  }
  const rawTransitions: RawTransition[] = [];

  for (let r = 0; r < n; r++) {
    const s = t.svc[r];
    const p = t.parent[r];
    if (p >= 0 && t.svc[p] !== s) {
      const isAsync = t.kind[p] === SpanKind.Producer || t.kind[r] === SpanKind.Consumer;
      rawTransitions.push({
        source: t.svc[p],
        target: s,
        calleeRow: r,
        pattern: isAsync ? EdgePattern.Async : EdgePattern.Sync,
      });
    }

    const tgt = clientTargetOfRow[r];
    if (tgt >= 0) {
      const isAsync = t.kind[r] === SpanKind.Producer;
      rawTransitions.push({
        source: s,
        target: tgt,
        calleeRow: r,
        pattern: isAsync ? EdgePattern.Async : EdgePattern.Sync,
      });
    }

    // Check span links
    const span = index.ordered[r]?.span;
    if (span?.links && span.links.length > 0) {
      for (const link of span.links) {
        const linked = index.spans.get(link.spanId);
        if (linked !== undefined && t.svc[linked.idx] !== s) {
          rawTransitions.push({
            source: t.svc[linked.idx],
            target: s,
            calleeRow: r,
            pattern: EdgePattern.Async,
          });
        }
      }
    }
  }

  // Deduplicate and aggregate edges by (source, target)
  const edgeKeyMap = new Map<string, number>();
  const edgeSources: number[] = [];
  const edgeTargets: number[] = [];
  const edgePatterns: EdgePattern[] = [];
  const edgeRowLists: number[][] = [];
  const edgeOfRow = new Int32Array(n).fill(-1);
  const edgesOfRow: (number[] | undefined)[] = new Array(n);

  for (const trans of rawTransitions) {
    const key = `${trans.source}|${trans.target}`;
    let e = edgeKeyMap.get(key);
    if (e === undefined) {
      e = edgeSources.length;
      edgeKeyMap.set(key, e);
      edgeSources.push(trans.source);
      edgeTargets.push(trans.target);
      edgePatterns.push(trans.pattern);
      edgeRowLists.push([trans.calleeRow]);
    } else {
      if (edgePatterns[e] !== trans.pattern) edgePatterns[e] = EdgePattern.Mixed;
      edgeRowLists[e].push(trans.calleeRow);
    }
    const callee = trans.calleeRow;
    if (edgeOfRow[callee] < 0) edgeOfRow[callee] = e;
    let list = edgesOfRow[callee];
    if (list === undefined) {
      list = [e];
      edgesOfRow[callee] = list;
    } else if (!list.includes(e)) {
      list.push(e);
    }
  }

  const edgeCount = edgeSources.length;
  const source = new Int32Array(edgeSources);
  const target = new Int32Array(edgeTargets);
  const pattern = new Uint8Array(edgePatterns);
  const isSelfLoop = new Uint8Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    if (source[e] === target[e]) isSelfLoop[e] = 1;
  }

  // Build compressed edgeRows array
  const edgeRowOff = new Int32Array(edgeCount + 1);
  let totalEdgeRows = 0;
  for (let e = 0; e < edgeCount; e++) {
    edgeRowOff[e] = totalEdgeRows;
    totalEdgeRows += edgeRowLists[e].length;
  }
  edgeRowOff[edgeCount] = totalEdgeRows;

  const edgeRows = new Int32Array(totalEdgeRows);
  for (let e = 0; e < edgeCount; e++) {
    const list = edgeRowLists[e];
    for (let i = 0; i < list.length; i++) edgeRows[edgeRowOff[e] + i] = list[i];
  }

  // ---------------------------------------------------------------------------
  // 5-Stage Zero-Dependency Hierarchical Sugiyama Layout
  // ---------------------------------------------------------------------------
  const { rank, nodeX, nodeY, width, height, reversed, edgePath, labelX, labelY } = layoutSugiyama(
    nodeCount,
    firstRowOfNode,
    source,
    target,
    isSelfLoop,
  );

  return {
    index,
    nodeCount,
    names: nodeNames,
    nodeKind,
    firstRowOfNode,
    isEntryNode,
    nodeOfRow,
    inferredTargetOfRow,
    isEntryRow,
    edgeCount,
    source,
    target,
    pattern,
    isSelfLoop,
    reversed,
    edgeOfRow,
    edgesOfRow,
    edgeRowOff,
    edgeRows,
    width,
    height,
    rank,
    nodeX,
    nodeY,
    edgePath,
    labelX,
    labelY,
  };
}

// -----------------------------------------------------------------------------
// Sugiyama Layout Implementation
// -----------------------------------------------------------------------------

interface LayoutResult {
  readonly rank: Int32Array;
  readonly nodeX: Float64Array;
  readonly nodeY: Float64Array;
  readonly width: number;
  readonly height: number;
  readonly reversed: Uint8Array;
  readonly edgePath: readonly string[];
  readonly labelX: Float64Array;
  readonly labelY: Float64Array;
}

function layoutSugiyama(
  nodeCount: number,
  firstRowOfNode: Int32Array,
  source: Int32Array,
  target: Int32Array,
  isSelfLoop: Uint8Array,
): LayoutResult {
  const edgeCount = source.length;
  const reversed = new Uint8Array(edgeCount);

  if (nodeCount === 0) {
    return {
      rank: new Int32Array(0),
      nodeX: new Float64Array(0),
      nodeY: new Float64Array(0),
      width: 0,
      height: 0,
      reversed,
      edgePath: [],
      labelX: new Float64Array(0),
      labelY: new Float64Array(0),
    };
  }

  if (nodeCount === 1) {
    const nodeX = new Float64Array([GRAPH_PAD]);
    const nodeY = new Float64Array([GRAPH_PAD]);
    const rank = new Int32Array([0]);
    const edgePath: string[] = [];
    const labelX = new Float64Array(edgeCount);
    const labelY = new Float64Array(edgeCount);
    for (let e = 0; e < edgeCount; e++) {
      // self loop
      const x = GRAPH_PAD;
      const y = GRAPH_PAD;
      edgePath.push(`M ${x + NODE_WIDTH - 24} ${y} C ${x + NODE_WIDTH - 24} ${y - 32}, ${x + NODE_WIDTH + 24} ${y - 32}, ${x + NODE_WIDTH} ${y + 20}`);
      labelX[e] = x + NODE_WIDTH;
      labelY[e] = y - 36;
    }
    return {
      rank,
      nodeX,
      nodeY,
      width: NODE_WIDTH + GRAPH_PAD * 2,
      height: NODE_HEIGHT + GRAPH_PAD * 2,
      reversed,
      edgePath,
      labelX,
      labelY,
    };
  }

  // 1. Connected components partition
  const adj = Array.from({ length: nodeCount }, () => new Set<number>());
  for (let e = 0; e < edgeCount; e++) {
    if (isSelfLoop[e] === 0) {
      adj[source[e]].add(target[e]);
      adj[target[e]].add(source[e]);
    }
  }

  const componentOf = new Int32Array(nodeCount).fill(-1);
  const components: number[][] = [];
  const nodeOrder = Array.from({ length: nodeCount }, (_, i) => i).sort((a, b) => firstRowOfNode[a] - firstRowOfNode[b]);

  for (const start of nodeOrder) {
    if (componentOf[start] >= 0) continue;
    const compIdx = components.length;
    const comp: number[] = [];
    const queue = [start];
    componentOf[start] = compIdx;
    while (queue.length > 0) {
      const u = queue.shift();
      if (u === undefined) break;
      comp.push(u);
      for (const v of adj[u]) {
        if (componentOf[v] < 0) {
          componentOf[v] = compIdx;
          queue.push(v);
        }
      }
    }
    components.push(comp);
  }

  // 2. Trace-causal cycle breaker for each component
  const outEdges = Array.from({ length: nodeCount }, () => [] as number[]);
  for (let e = 0; e < edgeCount; e++) {
    if (isSelfLoop[e] === 0) outEdges[source[e]].push(e);
  }

  const visited = new Uint8Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);

  function dfsCycle(u: number): void {
    visited[u] = 1;
    onStack[u] = 1;
    // visit outgoing edges in stable order
    const edges = outEdges[u].slice().sort((a, b) => firstRowOfNode[target[a]] - firstRowOfNode[target[b]]);
    for (const e of edges) {
      const v = target[e];
      if (onStack[v] === 1) {
        reversed[e] = 1;
      } else if (visited[v] === 0) {
        dfsCycle(v);
      }
    }
    onStack[u] = 0;
  }

  for (const u of nodeOrder) {
    if (visited[u] === 0) dfsCycle(u);
  }

  // 3. Longest Path Ranking on acyclic graph
  const rank = new Int32Array(nodeCount);
  const dagInDegree = new Int32Array(nodeCount);
  const dagOut = Array.from({ length: nodeCount }, () => [] as number[]);

  for (let e = 0; e < edgeCount; e++) {
    if (isSelfLoop[e] === 1) continue;
    const u = reversed[e] === 1 ? target[e] : source[e];
    const v = reversed[e] === 1 ? source[e] : target[e];
    dagOut[u].push(v);
    dagInDegree[v]++;
  }

  // Topological ranking
  const q: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if (dagInDegree[i] === 0) q.push(i);
  }
  // Order roots by firstRow
  q.sort((a, b) => firstRowOfNode[a] - firstRowOfNode[b]);

  const topo: number[] = [];
  while (q.length > 0) {
    const u = q.shift();
    if (u === undefined) break;
    topo.push(u);
    for (const v of dagOut[u]) {
      rank[v] = Math.max(rank[v], rank[u] + 1);
      dagInDegree[v]--;
      if (dagInDegree[v] === 0) q.push(v);
    }
  }

  // 4. Group nodes by rank within each component and apply barycenter crossing minimization
  let maxRank = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (rank[i] > maxRank) maxRank = rank[i];
  }

  const nodesByRank: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const u of nodeOrder) nodesByRank[rank[u]].push(u);

  // 4-pass barycenter heuristic
  for (let pass = 0; pass < 4; pass++) {
    const forward = pass % 2 === 0;
    const startRank = forward ? 1 : maxRank - 1;
    const endRank = forward ? maxRank + 1 : -1;
    const step = forward ? 1 : -1;

    for (let r = startRank; r !== endRank; r += step) {
      const prevRank = r - step;
      const prevPos = new Map<number, number>();
      for (let i = 0; i < nodesByRank[prevRank].length; i++) {
        prevPos.set(nodesByRank[prevRank][i], i);
      }

      const barycenters = new Map<number, number>();
      for (const u of nodesByRank[r]) {
        let sum = 0;
        let count = 0;
        for (const v of adj[u]) {
          const p = prevPos.get(v);
          if (p !== undefined) {
            sum += p;
            count++;
          }
        }
        barycenters.set(u, count > 0 ? sum / count : prevPos.size);
      }

      nodesByRank[r].sort((a, b) => (barycenters.get(a) ?? 0) - (barycenters.get(b) ?? 0) || firstRowOfNode[a] - firstRowOfNode[b]);
    }
  }

  // 5. Coordinate assignment
  const nodeX = new Float64Array(nodeCount);
  const nodeY = new Float64Array(nodeCount);

  let maxColHeight = 0;
  for (let r = 0; r <= maxRank; r++) {
    const count = nodesByRank[r].length;
    const h = count * NODE_HEIGHT + Math.max(0, count - 1) * NODE_GAP_Y;
    if (h > maxColHeight) maxColHeight = h;
  }

  for (let r = 0; r <= maxRank; r++) {
    const col = nodesByRank[r];
    const colHeight = col.length * NODE_HEIGHT + Math.max(0, col.length - 1) * NODE_GAP_Y;
    const startY = GRAPH_PAD + (maxColHeight - colHeight) / 2;
    const x = GRAPH_PAD + r * (NODE_WIDTH + RANK_GAP_X);

    for (let i = 0; i < col.length; i++) {
      const u = col[i];
      nodeX[u] = x;
      nodeY[u] = startY + i * (NODE_HEIGHT + NODE_GAP_Y);
    }
  }

  const totalWidth = GRAPH_PAD * 2 + (maxRank + 1) * NODE_WIDTH + maxRank * RANK_GAP_X;
  const totalHeight = GRAPH_PAD * 2 + maxColHeight;

  // 6. Generate edge cubic Bézier paths and midpoint labels
  const edgePath: string[] = new Array(edgeCount);
  const labelX = new Float64Array(edgeCount);
  const labelY = new Float64Array(edgeCount);

  // Group edges per source & target to distribute port Y offsets
  const outEdgesOf = Array.from({ length: nodeCount }, () => [] as number[]);
  const inEdgesOf = Array.from({ length: nodeCount }, () => [] as number[]);
  for (let e = 0; e < edgeCount; e++) {
    outEdgesOf[source[e]].push(e);
    inEdgesOf[target[e]].push(e);
  }

  for (let e = 0; e < edgeCount; e++) {
    const u = source[e];
    const v = target[e];

    if (isSelfLoop[e] === 1) {
      const x = nodeX[u];
      const y = nodeY[u];
      edgePath[e] = `M ${x + NODE_WIDTH - 24} ${y} C ${x + NODE_WIDTH - 24} ${y - 32}, ${x + NODE_WIDTH + 24} ${y - 32}, ${x + NODE_WIDTH} ${y + 20}`;
      labelX[e] = x + NODE_WIDTH;
      labelY[e] = y - 36;
      continue;
    }

    const isRev = reversed[e] === 1;
    // Port distribution
    const outList = outEdgesOf[u];
    const inList = inEdgesOf[v];
    const outIdx = Math.max(0, outList.indexOf(e));
    const inIdx = Math.max(0, inList.indexOf(e));

    const outFraction = (outIdx + 1) / (outList.length + 1);
    const inFraction = (inIdx + 1) / (inList.length + 1);

    if (!isRev && rank[u] <= rank[v]) {
      // Forward Left-to-Right edge
      const x0 = nodeX[u] + NODE_WIDTH;
      const y0 = nodeY[u] + NODE_HEIGHT * (0.25 + 0.5 * outFraction);
      const x1 = nodeX[v];
      const y1 = nodeY[v] + NODE_HEIGHT * (0.25 + 0.5 * inFraction);
      const dx = Math.max(RANK_GAP_X * 0.45, (x1 - x0) * 0.5);

      edgePath[e] = `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`;
      labelX[e] = (x0 + x1) / 2;
      labelY[e] = (y0 + y1) / 2 - 12;
    } else {
      // Feedback or reverse edge: bow underneath
      const x0 = nodeX[u] + NODE_WIDTH * 0.5;
      const y0 = nodeY[u] + NODE_HEIGHT;
      const x1 = nodeX[v] + NODE_WIDTH * 0.5;
      const y1 = nodeY[v] + NODE_HEIGHT;
      const bowY = Math.max(y0, y1) + 40;

      edgePath[e] = `M ${x0} ${y0} C ${x0} ${bowY}, ${x1} ${bowY}, ${x1} ${y1}`;
      labelX[e] = (x0 + x1) / 2;
      labelY[e] = bowY - 10;
    }
  }

  return {
    rank,
    nodeX,
    nodeY,
    width: Math.max(totalWidth, 400),
    height: Math.max(totalHeight, 300),
    reversed,
    edgePath,
    labelX,
    labelY,
  };
}

// -----------------------------------------------------------------------------
// Windowed Metrics & Interval-Union Self Time
// -----------------------------------------------------------------------------

/** Build windowed metrics over a static ServiceTopology. */
export function buildServiceGraph(topology: ServiceTopology, window: TimeWindow | null): ServiceGraph {
  const { index, nodeCount, edgeCount, nodeOfRow, isEntryRow, edgeRows, edgeRowOff } = topology;
  const t = index.table;
  const n = t.length;

  // 1. Exact O(N) interval-union self time clipped to window
  const weightOfRow = new Float64Array(n);
  const coveredByChildren = new Float64Array(n);
  const curStart = new Float64Array(n).fill(-1);
  const curEnd = new Float64Array(n).fill(-1);

  for (let r = 0; r < n; r++) {
    const from = window === null ? t.start[r] : Math.max(t.start[r], window.t0);
    const to = window === null ? t.end[r] : Math.min(t.end[r], window.t1);
    weightOfRow[r] = Math.max(0, to - from);

    const p = t.parent[r];
    if (p >= 0 && weightOfRow[r] > 0) {
      const pFrom = window === null ? t.start[p] : Math.max(t.start[p], window.t0);
      const pTo = window === null ? t.end[p] : Math.min(t.end[p], window.t1);
      const cStart = Math.max(from, pFrom);
      const cEnd = Math.min(to, pTo);

      if (cEnd > cStart) {
        if (curEnd[p] < 0) {
          curStart[p] = cStart;
          curEnd[p] = cEnd;
        } else if (cStart > curEnd[p]) {
          coveredByChildren[p] += curEnd[p] - curStart[p];
          curStart[p] = cStart;
          curEnd[p] = cEnd;
        } else {
          curEnd[p] = Math.max(curEnd[p], cEnd);
        }
      }
    }
  }

  // Flush remaining child intervals and compute self time
  const selfOfRow = new Float64Array(n);
  let totalSelfMs = 0;
  for (let r = 0; r < n; r++) {
    if (curEnd[r] >= 0) {
      coveredByChildren[r] += curEnd[r] - curStart[r];
    }
    const self = Math.max(0, weightOfRow[r] - coveredByChildren[r]);
    selfOfRow[r] = self;
    totalSelfMs += self;
  }

  // 2. Aggregate per-node metrics
  const spanCount = new Int32Array(nodeCount);
  const requestCount = new Int32Array(nodeCount);
  const errorCount = new Int32Array(nodeCount);
  const selfMs = new Float64Array(nodeCount);
  const totalMs = new Float64Array(nodeCount);
  const maxMs = new Float64Array(nodeCount);
  const entryDurationsByNode: number[][] = Array.from({ length: nodeCount }, () => []);

  for (let r = 0; r < n; r++) {
    const u = nodeOfRow[r];
    if (weightOfRow[r] > 0) {
      spanCount[u]++;
      if (t.status[r] === 2) errorCount[u]++;
      selfMs[u] += selfOfRow[r];

      if (isEntryRow[r] === 1) {
        requestCount[u]++;
        const d = weightOfRow[r];
        totalMs[u] += d;
        if (d > maxMs[u]) maxMs[u] = d;
        entryDurationsByNode[u].push(d);
      }

      const inf = topology.inferredTargetOfRow[r];
      if (inf >= 0) {
        spanCount[inf]++;
        requestCount[inf]++;
        if (t.status[r] === 2) errorCount[inf]++;
        const d = weightOfRow[r];
        selfMs[inf] += d;
        totalMs[inf] += d;
        if (d > maxMs[inf]) maxMs[inf] = d;
        entryDurationsByNode[inf].push(d);
      }
    }
  }

  const p95Ms = new Float64Array(nodeCount);
  for (let u = 0; u < nodeCount; u++) {
    const durs = entryDurationsByNode[u];
    if (durs.length > 0) {
      durs.sort((a, b) => a - b);
      const idx = Math.min(durs.length - 1, Math.floor(durs.length * 0.95));
      p95Ms[u] = durs[idx];
    }
  }

  // 3. Aggregate per-edge metrics
  const callCount = new Int32Array(edgeCount);
  const edgeErrorCount = new Int32Array(edgeCount);
  const edgeTotalMs = new Float64Array(edgeCount);
  const edgeAvgMs = new Float64Array(edgeCount);
  const edgeP95Ms = new Float64Array(edgeCount);
  const edgeMaxMs = new Float64Array(edgeCount);

  for (let e = 0; e < edgeCount; e++) {
    const isToInferred = topology.nodeKind[topology.target[e]] === NodeKind.Inferred;
    const fromRow = edgeRowOff[e];
    const toRow = edgeRowOff[e + 1];
    const durs: number[] = [];
    let sum = 0;
    let max = 0;
    let errors = 0;
    let calls = 0;

    for (let i = fromRow; i < toRow; i++) {
      const r = edgeRows[i];
      const d = weightOfRow[r];
      if (d > 0) {
        calls++;
        sum += d;
        if (d > max) max = d;
        durs.push(d);
        const hasError = isToInferred
          ? t.status[r] === 2
          : t.status[r] === 2 || (t.parent[r] >= 0 && t.status[t.parent[r]] === 2);
        if (hasError) errors++;
      }
    }

    callCount[e] = calls;
    edgeErrorCount[e] = errors;
    edgeTotalMs[e] = sum;
    edgeMaxMs[e] = max;
    edgeAvgMs[e] = calls > 0 ? sum / calls : 0;
    if (durs.length > 0) {
      durs.sort((a, b) => a - b);
      const idx = Math.min(durs.length - 1, Math.floor(durs.length * 0.95));
      edgeP95Ms[e] = durs[idx];
    }
  }

  return {
    topology,
    window,
    totalSelfMs,
    spanCount,
    requestCount,
    errorCount,
    selfMs,
    totalMs,
    p95Ms,
    maxMs,
    callCount,
    edgeErrorCount,
    edgeTotalMs,
    edgeAvgMs,
    edgeP95Ms,
    edgeMaxMs,
  };
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

/** Cached topology calculation, depends only on Slice.Data. */
export const serviceTopology: Selector<ServiceTopology> = defineSelector(
  'service.topology',
  Slice.Data,
  (state, previous) => {
    return previous !== undefined && previous.index === state.data.index
      ? previous
      : buildServiceTopology(state.data.index);
  },
);

/** Cached windowed metrics, depends on Slice.Data and Slice.Window. */
export const serviceGraph: Selector<ServiceGraph> = defineSelector(
  'service.graph',
  Slice.Data | Slice.Window,
  (state, previous) => {
    const topology = serviceTopology.compute(state, previous?.topology);
    const { window } = state;
    const same = previous !== undefined && previous.topology === topology
      && previous.window?.t0 === window?.t0 && previous.window?.t1 === window?.t1;
    return same ? previous : buildServiceGraph(topology, window);
  },
);

// -----------------------------------------------------------------------------
// Interaction and Description Helpers
// -----------------------------------------------------------------------------

/** All span IDs of a service node, and the primary span to describe in the detail panel. */
export function spansOfNode(
  graph: ServiceGraph,
  nodeIdx: number,
): { readonly ids: SpanId[]; readonly primary: SpanId | null } {
  const t = graph.topology.index.table;
  const ids: SpanId[] = [];
  let primary: SpanId | null = null;
  let firstFailingEntry: SpanId | null = null;
  let firstFailingAny: SpanId | null = null;
  let longestEntry: SpanId | null = null;
  let maxDuration = -1;

  for (let r = 0; r < t.length; r++) {
    const isNode = graph.topology.nodeOfRow[r] === nodeIdx || graph.topology.inferredTargetOfRow[r] === nodeIdx;
    if (isNode) {
      ids.push(t.ids[r]);
      const dur = t.end[r] - t.start[r];
      const isEntry = graph.topology.nodeOfRow[r] === nodeIdx ? graph.topology.isEntryRow[r] === 1 : true;
      if (t.status[r] === 2) {
        firstFailingAny ??= t.ids[r];
        if (isEntry) firstFailingEntry ??= t.ids[r];
      }
      if (isEntry && dur > maxDuration) {
        maxDuration = dur;
        longestEntry = t.ids[r];
      }
    }
  }

  primary = firstFailingEntry ?? firstFailingAny ?? longestEntry ?? (ids.length > 0 ? ids[0] : null);
  return { ids, primary };
}

/** All span IDs associated with an edge (caller and callee spans). */
export function spansOfEdge(
  graph: ServiceGraph,
  edgeIdx: number,
): { readonly ids: SpanId[]; readonly primary: SpanId | null } {
  const t = graph.topology.index.table;
  const ids: SpanId[] = [];
  const from = graph.topology.edgeRowOff[edgeIdx];
  const to = graph.topology.edgeRowOff[edgeIdx + 1];

  let primary: SpanId | null = null;
  let firstFailing: SpanId | null = null;
  let longest: SpanId | null = null;
  let maxDuration = -1;

  for (let i = from; i < to; i++) {
    const r = graph.topology.edgeRows[i];
    ids.push(t.ids[r]);
    if (t.parent[r] >= 0) ids.push(t.ids[t.parent[r]]);

    const dur = t.end[r] - t.start[r];
    if (t.status[r] === 2) firstFailing ??= t.ids[r];
    if (dur > maxDuration) {
      maxDuration = dur;
      longest = t.ids[r];
    }
  }

  primary = firstFailing ?? longest ?? (ids.length > 0 ? ids[0] : null);
  return { ids: [...new Set(ids)], primary };
}

/** Node indices that contain at least one of the given spans. */
export function nodesOfSpans(graph: ServiceGraph, ids: SpanSet | null): Set<number> {
  const nodes = new Set<number>();
  if (ids === null) return nodes;
  for (const id of ids) {
    const indexed = graph.topology.index.spans.get(id);
    if (indexed !== undefined) {
      nodes.add(graph.topology.nodeOfRow[indexed.idx]);
      const inf = graph.topology.inferredTargetOfRow[indexed.idx];
      if (inf >= 0) nodes.add(inf);
    }
  }
  return nodes;
}

/** Edge indices that match the given spans. */
export function edgesOfSpans(graph: ServiceGraph, ids: SpanSet | null): Set<number> {
  const edges = new Set<number>();
  if (ids === null) return edges;
  for (const id of ids) {
    const indexed = graph.topology.index.spans.get(id);
    if (indexed !== undefined) {
      const r = indexed.idx;
      const rowEdges = graph.topology.edgesOfRow?.[r];
      if (rowEdges !== undefined && rowEdges.length > 0) {
        for (let i = 0; i < rowEdges.length; i++) edges.add(rowEdges[i]);
      } else {
        const e = graph.topology.edgeOfRow[r];
        if (e >= 0) edges.add(e);
      }
    }
  }
  return edges;
}

/** Node matches for filter bar: 1 if at least one span in the node passed filter. */
export function nodesMatched(graph: ServiceGraph, matched: SpanMask | null): Uint8Array | null {
  if (matched === null) return null;
  const result = new Uint8Array(graph.topology.nodeCount);
  for (let r = 0; r < matched.bits.length; r++) {
    if (matched.bits[r] === 1) {
      result[graph.topology.nodeOfRow[r]] = 1;
      const inf = graph.topology.inferredTargetOfRow[r];
      if (inf >= 0) result[inf] = 1;
    }
  }
  return result;
}

/** Edge matches for filter bar: 1 if caller or callee passed filter. */
export function edgesMatched(graph: ServiceGraph, matched: SpanMask | null): Uint8Array | null {
  if (matched === null) return null;
  const result = new Uint8Array(graph.topology.edgeCount);
  for (let e = 0; e < graph.topology.edgeCount; e++) {
    const from = graph.topology.edgeRowOff[e];
    const to = graph.topology.edgeRowOff[e + 1];
    for (let i = from; i < to; i++) {
      const r = graph.topology.edgeRows[i];
      if (matched.bits[r] === 1 || (graph.topology.index.table.parent[r] >= 0 && matched.bits[graph.topology.index.table.parent[r]] === 1)) {
        result[e] = 1;
        break;
      }
    }
  }
  return result;
}

/** Describe a node for the tooltip. */
export function describeNode(graph: ServiceGraph, nodeIdx: number): InfoModel {
  const name = graph.topology.names[nodeIdx];
  const isInf = graph.topology.nodeKind[nodeIdx] === NodeKind.Inferred;
  const self = graph.selfMs[nodeIdx];
  const share = graph.totalSelfMs > 0 ? `${((self / graph.totalSelfMs) * 100).toFixed(1)}%` : '0%';
  const errors = graph.errorCount[nodeIdx];
  const reqs = graph.requestCount[nodeIdx];

  const rows: InfoRow[] = [
    ['Requests', String(reqs)],
    ['Spans', String(graph.spanCount[nodeIdx])],
    ['Self time', `${formatDuration(self)} (${share})`],
    ['Total time', formatDuration(graph.totalMs[nodeIdx])],
    ['p95 Latency', formatDuration(graph.p95Ms[nodeIdx])],
    ['Max Latency', formatDuration(graph.maxMs[nodeIdx])],
  ];
  if (errors > 0) {
    const rate = reqs > 0 ? ` (${((errors / reqs) * 100).toFixed(1)}%)` : '';
    rows.push(['Errors', `${errors}${rate}`]);
  }

  const sections: InfoSection[] = [{ title: isInf ? 'Inferred Dependency' : 'Service', rows }];
  return {
    title: name,
    subtitle: isInf ? 'External dependency' : 'Service',
    status: errors > 0 ? 'error' : 'ok',
    sections,
  };
}

/** Describe an edge for the tooltip. */
export function describeEdge(graph: ServiceGraph, edgeIdx: number): InfoModel {
  const srcName = graph.topology.names[graph.topology.source[edgeIdx]];
  const dstName = graph.topology.names[graph.topology.target[edgeIdx]];
  const calls = graph.callCount[edgeIdx];
  const errors = graph.edgeErrorCount[edgeIdx];
  const pat = graph.topology.pattern[edgeIdx];
  const patName = pat === EdgePattern.Sync ? 'Synchronous RPC' : pat === EdgePattern.Async ? 'Asynchronous Messaging' : 'Mixed Calls';

  const rows: InfoRow[] = [
    ['Calls', String(calls)],
    ['Pattern', patName],
    ['Avg Duration', formatDuration(graph.edgeAvgMs[edgeIdx])],
    ['p95 Duration', formatDuration(graph.edgeP95Ms[edgeIdx])],
    ['Max Duration', formatDuration(graph.edgeMaxMs[edgeIdx])],
    ['Total Time', formatDuration(graph.edgeTotalMs[edgeIdx])],
  ];
  if (errors > 0) {
    const rate = calls > 0 ? ` (${((errors / calls) * 100).toFixed(1)}%)` : '';
    rows.push(['Errors', `${errors}${rate}`]);
  }

  return {
    title: `${srcName} → ${dstName}`,
    subtitle: 'Service Communication',
    status: errors > 0 ? 'error' : 'ok',
    sections: [{ title: 'Traffic', rows }],
  };
}

/** Find a neighboring node for keyboard arrow navigation. */
export function neighbourNode(
  graph: ServiceGraph,
  nodeIdx: number,
  way: 'up' | 'down' | 'left' | 'right',
): number {
  const { nodeCount, rank, source, target, edgeCount } = graph.topology;
  if (nodeIdx < 0 || nodeIdx >= nodeCount) return nodeCount > 0 ? 0 : -1;

  if (way === 'right') {
    // Heaviest outgoing edge
    let best = -1;
    let maxCalls = -1;
    for (let e = 0; e < edgeCount; e++) {
      if (source[e] === nodeIdx && target[e] !== nodeIdx) {
        if (graph.callCount[e] > maxCalls) {
          maxCalls = graph.callCount[e];
          best = target[e];
        }
      }
    }
    return best;
  }

  if (way === 'left') {
    // Heaviest incoming edge
    let best = -1;
    let maxCalls = -1;
    for (let e = 0; e < edgeCount; e++) {
      if (target[e] === nodeIdx && source[e] !== nodeIdx) {
        if (graph.callCount[e] > maxCalls) {
          maxCalls = graph.callCount[e];
          best = source[e];
        }
      }
    }
    return best;
  }

  // Up/down within the same rank column
  const myRank = rank[nodeIdx];
  const sameRankNodes: number[] = [];
  for (let u = 0; u < nodeCount; u++) {
    if (rank[u] === myRank) sameRankNodes.push(u);
  }
  sameRankNodes.sort((a, b) => graph.topology.nodeY[a] - graph.topology.nodeY[b]);
  const pos = sameRankNodes.indexOf(nodeIdx);
  if (pos < 0) return -1;

  if (way === 'up') return pos > 0 ? sameRankNodes[pos - 1] : -1;
  if (way === 'down') return pos < sameRankNodes.length - 1 ? sameRankNodes[pos + 1] : -1;
  return -1;
}
