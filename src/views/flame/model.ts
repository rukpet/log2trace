/**
 * The flame graph's model: the trace folded into boxes, and the boxes laid out as bars.
 *
 * A box is every span that has the same call path (service, name and kind of the span and of each
 * ancestor), so the boxes partition the spans and a box is the "set of spans" a selection or a hover
 * of this view puts in the store. A box is as wide as the time its spans take together:
 *
 * - the weight of a span is its duration (clipped to the shared time window), or the sum of the
 *   weights of its children when they run in parallel and add up to more;
 * - the weight of a box is the sum of the weights of its spans, so the children of a box never add
 *   up to more than the box itself;
 * - the self time of a box is its weight minus the weights of its children.
 *
 * Children are ordered heaviest first. The tree depends on the data and the time window only; the
 * focus (which box fills the width) and the width belong to the view and enter only the layout.
 *
 * Headless: no DOM, no browser globals.
 */

import {
  Slice, defineSelector, formatDuration,
  type InfoModel, type Selector, type SpanId, type SpanIndex, type SpanSet, type TimeWindow,
} from '../../core.ts';

/** The trace folded into boxes: parallel arrays with one entry per box, in order of first appearance. */
export interface FlameTree {
  readonly index: SpanIndex;
  /** The window the weights are clipped to; `null` for the whole trace. */
  readonly window: TimeWindow | null;
  /** Number of boxes. Box `count` is the virtual root over the top-level boxes. */
  readonly count: number;
  /** Parent box, -1 for a top-level one. */
  readonly parent: Int32Array;
  readonly depth: Int32Array;
  /** Total time of the box's spans, ms. */
  readonly weight: Float64Array;
  /** Time the box spends outside its children, ms. */
  readonly self: Float64Array;
  /** Number of spans in the box. */
  readonly spans: Int32Array;
  /** The first row of the box in the span table, which gives its name, service and kind. */
  readonly row: Int32Array;
  /** 1 when one of the box's spans failed. */
  readonly failed: Uint8Array;
  /** The box of each table row. */
  readonly boxOfRow: Int32Array;
  /** Children of box `b` (or of the root, `b === count`) are `children[childOff[b] … childOff[b + 1] - 1]`, heaviest first. */
  readonly childOff: Int32Array;
  readonly children: Int32Array;
  /** Weight of the whole trace: the sum of the top-level boxes. */
  readonly total: number;
}

/** Fold the spans of an index into boxes, weighing them inside `window`. */
export function buildFlameTree(index: SpanIndex, window: TimeWindow | null): FlameTree {
  const t = index.table;
  const n = t.length;

  // the weight of every span, children before parents (rows are in depth-first order)
  const weightOfRow = new Float64Array(n);
  const childSum = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    const from = window === null ? t.start[row] : Math.max(t.start[row], window.t0);
    const to = window === null ? t.end[row] : Math.min(t.end[row], window.t1);
    const w = Math.max(to - from, childSum[row], 0);
    weightOfRow[row] = w;
    if (t.parent[row] >= 0) childSum[t.parent[row]] += w;
  }

  const parent = new Int32Array(n);
  const depth = new Int32Array(n);
  const weight = new Float64Array(n);
  const self = new Float64Array(n);
  const spans = new Int32Array(n);
  const rowOf = new Int32Array(n);
  const failed = new Uint8Array(n);
  const boxOfRow = new Int32Array(n);
  const known = new Map<string, number>();
  let count = 0;
  for (let row = 0; row < n; row++) {
    const above = t.parent[row] < 0 ? -1 : boxOfRow[t.parent[row]];
    const key = `${above}|${t.svc[row]}|${t.nameId[row]}|${t.kind[row]}`;
    let box = known.get(key);
    if (box === undefined) {
      box = count++;
      known.set(key, box);
      parent[box] = above;
      depth[box] = above < 0 ? 0 : depth[above] + 1;
      rowOf[box] = row;
    }
    boxOfRow[row] = box;
    weight[box] += weightOfRow[row];
    self[box] += weightOfRow[row] - childSum[row];
    spans[box]++;
    if (t.status[row] === 2) failed[box] = 1;
  }

  // children by counting sort on the parent, then heaviest first
  const childOff = new Int32Array(count + 2);
  for (let box = 0; box < count; box++) childOff[(parent[box] < 0 ? count : parent[box]) + 1]++;
  for (let box = 0; box <= count; box++) childOff[box + 1] += childOff[box];
  const children = new Int32Array(count);
  const fill = childOff.slice(0, count + 1);
  let total = 0;
  for (let box = 0; box < count; box++) {
    children[fill[parent[box] < 0 ? count : parent[box]]++] = box;
    if (parent[box] < 0) total += weight[box];
  }
  for (let box = 0; box <= count; box++) {
    if (childOff[box + 1] - childOff[box] > 1) {
      children.subarray(childOff[box], childOff[box + 1]).sort((a, b) => weight[b] - weight[a] || a - b);
    }
  }

  return {
    index, window, count,
    parent: parent.subarray(0, count), depth: depth.subarray(0, count), weight: weight.subarray(0, count),
    self: self.subarray(0, count), spans: spans.subarray(0, count), row: rowOf.subarray(0, count),
    failed: failed.subarray(0, count), boxOfRow, childOff, children, total,
  };
}

/** The tree of the loaded trace, cached until the data or the time window changes. */
export const flameTree: Selector<FlameTree> = defineSelector(
  'flame.tree',
  Slice.Data | Slice.Window,
  (state, previous) => {
    const { window } = state;
    const same = previous !== undefined && previous.index === state.data.index
      && previous.window?.t0 === window?.t0 && previous.window?.t1 === window?.t1;
    return same ? previous : buildFlameTree(state.data.index, window);
  },
);

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

/** The bars to draw: parallel arrays with one entry per bar. */
export interface FlameLayout {
  /** Number of bars. */
  readonly n: number;
  readonly box: Int32Array;
  /** Left edge and width in px. */
  readonly x: Float64Array;
  readonly w: Float64Array;
  /** Deepest row drawn, so the content is `rows` rows high. */
  readonly rows: number;
  /** Where the bar of each box is, or -1 when it is not drawn. Valid for boxes up to `tree.count`. */
  readonly slotOfBox: Int32Array;
}

/** A bar narrower than this (px) is not drawn, nor is anything above it. */
export const MIN_BAR_WIDTH = 1.5;

/**
 * Lay the boxes out over `width` px. The `focus` box (or the whole trace for `-1`) fills the width
 * and its ancestors are kept above it at full width, so the way back is always on screen; boxes
 * that would be narrower than {@link MIN_BAR_WIDTH} are left out together with their children,
 * which is what keeps a trace of 50,000 spans down to a few thousand bars.
 */
export function layoutFlame(tree: FlameTree, focus: number, width: number): FlameLayout {
  const box = new Int32Array(tree.count);
  const x = new Float64Array(tree.count);
  const w = new Float64Array(tree.count);
  const slotOfBox = new Int32Array(tree.count).fill(-1);
  let n = 0;
  let rows = 0;
  const add = (b: number, left: number, size: number): void => {
    box[n] = b; x[n] = left; w[n] = size;
    slotOfBox[b] = n++;
    if (tree.depth[b] + 1 > rows) rows = tree.depth[b] + 1;
  };

  const basis = focus >= 0 ? tree.weight[focus] : tree.total;
  if (!(basis > 0) || !(width > 0)) return { n: 0, box, x, w, rows: 0, slotOfBox };
  const scale = width / basis;

  if (focus >= 0) for (let b = tree.parent[focus]; b >= 0; b = tree.parent[b]) add(b, 0, width);

  const stackBox = new Int32Array(tree.count + 1);
  const stackX = new Float64Array(tree.count + 1);
  let top = 0;
  if (focus >= 0) {
    stackBox[top] = focus; stackX[top++] = 0;
    add(focus, 0, width);
  } else {
    stackBox[top] = tree.count; stackX[top++] = 0;
  }
  while (top > 0) {
    top--;
    const parent = stackBox[top];
    let left = stackX[top];
    for (let k = tree.childOff[parent]; k < tree.childOff[parent + 1]; k++) {
      const child = tree.children[k];
      const size = tree.weight[child] * scale;
      if (size < MIN_BAR_WIDTH) break; // heaviest first: the rest is narrower still
      add(child, left, size);
      stackBox[top] = child; stackX[top++] = left;
      left += size;
    }
  }
  return { n, box, x, w, rows, slotOfBox };
}

// -----------------------------------------------------------------------------
// Boxes, spans and what to say about them
// -----------------------------------------------------------------------------

/** The name of a box, which is the name of its spans. */
export function boxName(tree: FlameTree, box: number): string {
  const t = tree.index.table;
  return t.names[t.nameId[tree.row[box]]];
}

/** The ids of a box's spans, and the one to describe: the longest. */
export function spansOfBox(tree: FlameTree, box: number): { readonly ids: SpanId[]; readonly primary: SpanId } {
  const t = tree.index.table;
  const ids: SpanId[] = [];
  let primary = t.ids[tree.row[box]];
  let longest = -1;
  for (let row = tree.row[box]; row < t.length; row++) {
    if (tree.boxOfRow[row] !== box) continue;
    ids.push(t.ids[row]);
    if (t.end[row] - t.start[row] > longest) {
      longest = t.end[row] - t.start[row];
      primary = t.ids[row];
    }
  }
  return { ids, primary };
}

/** The boxes that hold at least one of the given spans. */
export function boxesOfSpans(tree: FlameTree, ids: SpanSet | null): Set<number> {
  const boxes = new Set<number>();
  if (ids === null) return boxes;
  for (const id of ids) {
    const indexed = tree.index.spans.get(id);
    if (indexed !== undefined) boxes.add(tree.boxOfRow[indexed.idx]);
  }
  return boxes;
}

/** One byte per box: 1 when one of its spans is in the mask of spans that passed the filter. */
export function boxesMatched(tree: FlameTree, matched: { readonly bits: Uint8Array } | null): Uint8Array | null {
  if (matched === null) return null;
  const result = new Uint8Array(tree.count);
  for (let row = 0; row < matched.bits.length; row++) {
    if (matched.bits[row] === 1) result[tree.boxOfRow[row]] = 1;
  }
  return result;
}

/** Neighbours for the arrow keys: the parent, the heaviest child, the sibling before or after. */
export function neighbour(tree: FlameTree, box: number, way: 'parent' | 'child' | 'previous' | 'next'): number {
  if (way === 'parent') return tree.parent[box];
  if (way === 'child') return tree.childOff[box] < tree.childOff[box + 1] ? tree.children[tree.childOff[box]] : -1;
  const up = tree.parent[box] < 0 ? tree.count : tree.parent[box];
  for (let k = tree.childOff[up]; k < tree.childOff[up + 1]; k++) {
    if (tree.children[k] !== box) continue;
    const other = k + (way === 'next' ? 1 : -1);
    return other >= tree.childOff[up] && other < tree.childOff[up + 1] ? tree.children[other] : -1;
  }
  return -1;
}

/** What a tooltip says about a box. */
export function describeBox(tree: FlameTree, box: number): InfoModel {
  const t = tree.index.table;
  const row = tree.row[box];
  const share = tree.total > 0 ? `${((tree.weight[box] / tree.total) * 100).toFixed(1)}%` : '–';
  return {
    title: boxName(tree, box),
    subtitle: t.services[t.svc[row]],
    status: tree.failed[box] === 1 ? 'error' : undefined,
    sections: [{
      title: 'Box',
      rows: [
        ['Total', formatDuration(tree.weight[box])],
        ['Self', formatDuration(tree.self[box])],
        ['Spans', String(tree.spans[box])],
        ['Share of trace', share],
      ],
    }],
  };
}
