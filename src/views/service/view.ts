/**
 * The Service Graph (Service Dependency Map) view.
 *
 * Visualizes services as nodes and inter-service communications as directed edges,
 * with zero external visualization dependencies. Synchronizes with the shared store
 * (data, selection, hover target, filter matches, and time-window bounds).
 */

import {
  Slice,
  formatDuration,
  touches,
  type ChangeSet,
  type SpanId,
} from '../../core.ts';
import * as a11yStyles from '../../kit/a11y.css.ts';
import type { ViewCommand } from '../../kit/commands.ts';
import { h } from '../../kit/dom.ts';
import {
  createCamera2D,
  fitBounds2D,
  formatZoom2D,
  panCamera2D,
  resizeCamera2D,
  worldToScreen,
  zoomCamera2DAt,
  type Camera2D,
} from '../../kit/geometry/camera2d.ts';
import { bindInput } from '../../kit/input/bind.ts';
import { InputActionKind, Key, type InputAction } from '../../kit/input/types.ts';
import { getFrameScheduler, type FrameHandle } from '../../kit/scheduler.ts';
import type { RendererKind, TraceView, ViewContext, ViewDefinition } from '../../kit/view.ts';
import {
  NodeKind,
  describeEdge,
  describeNode,
  edgesMatched,
  edgesOfSpans,
  neighbourNode,
  nodesMatched,
  nodesOfSpans,
  serviceGraph,
  spansOfEdge,
  spansOfNode,
  NODE_HEIGHT,
  NODE_WIDTH,
  type ServiceGraph,
} from './model.ts';
import * as styles from './view.css.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

enum Dirty {
  Layout = 1,
  Camera = 2,
  Flags = 4,
}

interface NodeSlot {
  readonly el: HTMLElement;
  readonly nodeIdx: number;
  readonly titleEl: HTMLElement;
  readonly badgeEl: HTMLElement;
  readonly metricsEl: HTMLElement;
  readonly fillEl: HTMLElement;
  entryBadgeEl: HTMLElement | null;
  flags: number;
}

interface EdgeSlot {
  readonly groupEl: SVGElement;
  readonly lineEl: SVGPathElement;
  readonly hitEl: SVGPathElement;
  readonly labelEl: HTMLElement;
  readonly edgeIdx: number;
  flags: number;
}

interface SavedState {
  readonly generation: number;
  readonly camera: Camera2D;
}

function isSavedState(value: unknown): value is SavedState {
  if (typeof value !== 'object' || value === null) return false;
  const { generation, camera } = value as Partial<SavedState>;
  return typeof generation === 'number' && typeof camera === 'object' && camera !== null;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** The Service Graph view. */
export class ServiceView implements TraceView {
  readonly renderer: RendererKind = 'dom';
  private mounted: {
    readonly ctx: ViewContext;
    readonly root: HTMLElement;
    readonly world: HTMLElement;
    readonly svg: SVGSVGElement;
    readonly nodesContainer: HTMLElement;
    readonly note: HTMLElement;
    readonly live: HTMLElement;
    readonly frame: FrameHandle;
    readonly observer: ResizeObserver;
    readonly unbindInput: () => void;
    readonly nodeSlots: Map<number, NodeSlot>;
    readonly edgeSlots: Map<number, EdgeSlot>;
    readonly elementToNode: WeakMap<Element, number>;
    readonly elementToEdge: WeakMap<Element, number>;
    graph: ServiceGraph;
    camera: Camera2D;
    generation: number;
    width: number;
    height: number;
    hoverTarget: { type: 'node' | 'edge'; idx: number } | null;
    selectedNodes: ReadonlySet<number>;
    selectedEdges: ReadonlySet<number>;
    hoveredNodes: ReadonlySet<number>;
    hoveredEdges: ReadonlySet<number>;
    matchedNodes: Uint8Array | null;
    matchedEdges: Uint8Array | null;
    matchedFor: unknown;
    initialFitDone: boolean;
  } | null = null;

  mount(surface: HTMLElement, ctx: ViewContext): void {
    if (this.mounted !== null) return;
    const graph = ctx.store.derive(serviceGraph);

    const world = h('div', { class: styles.world });
    const nodesContainer = h('div', { class: styles.nodes });
    const note = h('div', { class: styles.empty }, 'No spans to show.');
    const live = h('div', { class: a11yStyles.visuallyHidden, 'aria-live': 'polite' });
    const root = h('div', { class: styles.root, part: 'service', tabindex: 0, role: 'application', 'aria-label': 'Service dependency graph' }, world, note);

    surface.append(root, live);

    // SVG Layer
    const svg = svgEl('svg', { class: styles.edgesSvg });
    const defs = svgEl('defs');

    // Arrow markers
    const createMarker = (id: string, colorClass: string): SVGMarkerElement => {
      const marker = svgEl('marker', {
        id,
        viewBox: '0 0 10 10',
        refX: '9',
        refY: '5',
        markerWidth: '6',
        markerHeight: '6',
        orient: 'auto-start-reverse',
      });
      const poly = svgEl('polygon', { points: '0 1.5, 10 5, 0 8.5', class: colorClass });
      marker.append(poly);
      return marker;
    };

    defs.append(
      createMarker('l2t-arrow-default', styles.edgeLine),
      createMarker('l2t-arrow-error', styles.edgeLineError),
      createMarker('l2t-arrow-selected', styles.edgeLineSelected),
    );
    svg.append(defs);
    world.append(svg, nodesContainer);

    const frame = getFrameScheduler().register({ paint: (dirty) => this.paint(dirty) });
    const observer = new ResizeObserver(() => {
      const m = this.mounted;
      if (m === null) return;
      const { clientWidth, clientHeight } = m.root;
      if (clientWidth !== m.width || clientHeight !== m.height) {
        m.width = clientWidth;
        m.height = clientHeight;
        m.camera = resizeCamera2D(m.camera, clientWidth, clientHeight);
        if (!m.initialFitDone && clientWidth > 0 && clientHeight > 0) {
          this.fitAll();
          m.initialFitDone = true;
        }
        m.frame.mark(Dirty.Camera);
      }
    });

    const unbindInput = bindInput(root, {
      onAction: (action) => this.onInputAction(action),
      wheelZoom: () => true,
    });

    this.mounted = {
      ctx,
      root,
      world,
      svg,
      nodesContainer,
      note,
      live,
      frame,
      observer,
      unbindInput,
      nodeSlots: new Map(),
      edgeSlots: new Map(),
      elementToNode: new WeakMap(),
      elementToEdge: new WeakMap(),
      graph,
      camera: createCamera2D(0, 0),
      generation: ctx.store.state.data.generation,
      width: 0,
      height: 0,
      hoverTarget: null,
      selectedNodes: new Set(),
      selectedEdges: new Set(),
      hoveredNodes: new Set(),
      hoveredEdges: new Set(),
      matchedNodes: null,
      matchedEdges: null,
      matchedFor: null,
      initialFitDone: false,
    };

    observer.observe(root);
    frame.mark(Dirty.Layout | Dirty.Flags | Dirty.Camera);
  }

  unmount(): void {
    const m = this.mounted;
    if (m === null) return;
    this.mounted = null;
    m.observer.disconnect();
    m.unbindInput();
    m.frame.dispose();
    if (m.hoverTarget !== null) m.ctx.store.setHover(null, { origin: m.ctx.origin });
    m.root.remove();
    m.live.remove();
    m.ctx.hover(null);
  }

  update(change: ChangeSet): void {
    const m = this.mounted;
    if (m === null) return;

    if (touches(change, Slice.Data)) {
      m.generation = m.ctx.store.state.data.generation;
      m.initialFitDone = false;
      m.hoverTarget = null;
      m.ctx.hover(null);
    }

    if (touches(change, Slice.Data | Slice.Window)) {
      m.graph = m.ctx.store.derive(serviceGraph);
      m.frame.mark(Dirty.Layout | Dirty.Flags);
    } else if (touches(change, Slice.Selection | Slice.Hover | Slice.Filter)) {
      m.frame.mark(Dirty.Flags);
    }

    if (touches(change, Slice.Selection | Slice.Data)) m.ctx.refreshCommands();
  }

  optionsChanged(): void {
    // follow element options if needed
  }

  themeChanged(): void {
    // token custom properties restyle the view automatically
  }

  commands(): readonly ViewCommand[] {
    const m = this.mounted;
    if (m === null) return [];
    return [
      {
        id: 'zoom-in',
        label: 'Zoom in',
        run: () => this.zoomStep(1.3),
      },
      {
        id: 'zoom-out',
        label: 'Zoom out',
        run: () => this.zoomStep(1 / 1.3),
      },
      {
        id: 'zoom-reset',
        label: 'Fit graph to view',
        run: () => this.fitAll(),
        readout: () => formatZoom2D(m.camera.scale),
      },
    ];
  }

  focus(): void {
    this.mounted?.root.focus({ preventScroll: true });
  }

  reveal(id: SpanId): void {
    const m = this.mounted;
    if (m === null) return;
    const indexed = m.graph.topology.index.spans.get(id);
    if (indexed === undefined) return;
    const nodeIdx = m.graph.topology.nodeOfRow[indexed.idx];
    if (nodeIdx >= 0) this.focusOnNode(nodeIdx);
  }

  getState(): unknown {
    const m = this.mounted;
    return m === null ? null : ({ generation: m.generation, camera: m.camera } satisfies SavedState);
  }

  setState(state: unknown): void {
    const m = this.mounted;
    if (m === null || !isSavedState(state) || state.generation !== m.generation) return;
    m.camera = state.camera;
    m.initialFitDone = true;
    m.frame.mark(Dirty.Camera);
  }

  // ---------------------------------------------------------------------------
  // Frame Painting
  // ---------------------------------------------------------------------------

  private paint(dirty: number): number | void {
    const m = this.mounted;
    if (m === null) return;
    if (m.width === 0) {
      m.width = m.root.clientWidth;
      m.height = m.root.clientHeight;
      m.camera = resizeCamera2D(m.camera, m.width, m.height);
    }
    if (m.width === 0) return dirty;

    if ((dirty & Dirty.Layout) !== 0) this.rebuildGraph();
    if ((dirty & Dirty.Flags) !== 0) this.readFlags();
    if ((dirty & Dirty.Camera) !== 0) this.applyCamera();
  }

  private rebuildGraph(): void {
    const m = this.mounted;
    if (m === null) return;
    const { graph } = m;
    const { topology } = graph;

    m.note.hidden = topology.nodeCount > 0;
    m.svg.setAttribute('width', String(topology.width));
    m.svg.setAttribute('height', String(topology.height));

    if (!m.initialFitDone && m.width > 0 && m.height > 0) {
      this.fitAll();
      m.initialFitDone = true;
    }

    // Build or update nodes
    for (let u = 0; u < topology.nodeCount; u++) {
      let slot = m.nodeSlots.get(u);
      if (slot === undefined) slot = this.acquireNodeSlot(u);
      this.updateNodeContent(slot, u);
    }

    // Remove excess nodes
    for (const [u, slot] of m.nodeSlots) {
      if (u >= topology.nodeCount) {
        slot.el.remove();
        m.nodeSlots.delete(u);
      }
    }

    // Build or update edges
    for (let e = 0; e < topology.edgeCount; e++) {
      let slot = m.edgeSlots.get(e);
      if (slot === undefined) slot = this.acquireEdgeSlot(e);
      this.updateEdgeContent(slot, e);
    }

    // Remove excess edges
    for (const [e, slot] of m.edgeSlots) {
      if (e >= topology.edgeCount) {
        slot.groupEl.remove();
        slot.labelEl.remove();
        m.edgeSlots.delete(e);
      }
    }

    m.ctx.refreshCommands();
  }

  private acquireNodeSlot(nodeIdx: number): NodeSlot {
    const m = this.mounted as NonNullable<typeof this.mounted>;
    const titleEl = h('span', { class: styles.nodeTitle });
    const badgeEl = h('span', { class: styles.nodeBadge });
    const header = h('div', { class: styles.nodeHeader }, titleEl, badgeEl);
    const metricsEl = h('div', { class: styles.nodeMetrics });
    const fillEl = h('div', { class: styles.nodeSelfFill });
    const bar = h('div', { class: styles.nodeSelfBar }, fillEl);

    const el = h(
      'div',
      {
        class: styles.node,
        role: 'button',
        tabindex: 0,
        'data-node-id': String(nodeIdx),
      },
      header,
      metricsEl,
      bar,
    );

    m.elementToNode.set(el, nodeIdx);
    m.nodesContainer.append(el);

    const slot: NodeSlot = { el, nodeIdx, titleEl, badgeEl, metricsEl, fillEl, entryBadgeEl: null, flags: 0 };
    m.nodeSlots.set(nodeIdx, slot);
    return slot;
  }

  private updateNodeContent(slot: NodeSlot, nodeIdx: number): void {
    const m = this.mounted;
    if (m === null) return;
    const { graph } = m;
    const { topology } = graph;

    slot.el.style.left = `${topology.nodeX[nodeIdx]}px`;
    slot.el.style.top = `${topology.nodeY[nodeIdx]}px`;
    slot.el.setAttribute('data-service-name', topology.names[nodeIdx] ?? '');
    slot.el.classList.toggle(styles.nodeInferred, topology.nodeKind[nodeIdx] === NodeKind.Inferred);

    if (topology.isEntryNode[nodeIdx] === 1) {
      if (slot.entryBadgeEl === null) {
        slot.entryBadgeEl = h('div', { class: styles.nodeEntryBadge, title: 'Entrypoint' }, '▶');
        slot.el.append(slot.entryBadgeEl);
      } else {
        slot.entryBadgeEl.hidden = false;
        slot.entryBadgeEl.style.display = '';
      }
    } else if (slot.entryBadgeEl !== null) {
      slot.entryBadgeEl.hidden = true;
      slot.entryBadgeEl.style.display = 'none';
    }

    slot.titleEl.textContent = topology.names[nodeIdx];

    const errors = graph.errorCount[nodeIdx];
    const reqs = graph.requestCount[nodeIdx];
    const self = graph.selfMs[nodeIdx];

    slot.badgeEl.textContent = errors > 0 ? `${errors} err` : `${reqs} req${reqs === 1 ? '' : 's'}`;
    slot.badgeEl.classList.toggle(styles.nodeBadgeError, errors > 0);

    const p95Text = graph.p95Ms[nodeIdx] > 0 ? ` · p95 ${formatDuration(graph.p95Ms[nodeIdx])}` : '';
    slot.metricsEl.textContent = `${graph.spanCount[nodeIdx]} spans · Self ${formatDuration(self)}${p95Text}`;

    const selfRatio = graph.totalSelfMs > 0 ? Math.min(100, Math.max(0, (self / graph.totalSelfMs) * 100)) : 0;
    slot.fillEl.style.width = `${selfRatio.toFixed(1)}%`;
  }

  private acquireEdgeSlot(edgeIdx: number): EdgeSlot {
    const m = this.mounted as NonNullable<typeof this.mounted>;
    const groupEl = svgEl('g', { class: styles.edgeGroup, 'data-edge-id': String(edgeIdx) });
    const lineEl = svgEl('path', { class: styles.edgeLine });
    const hitEl = svgEl('path', { class: styles.edgeHit });
    groupEl.append(lineEl, hitEl);
    m.svg.append(groupEl);

    const labelEl = h('div', { class: styles.edgeLabel, 'data-edge-id': String(edgeIdx) });
    m.nodesContainer.append(labelEl);

    m.elementToEdge.set(groupEl, edgeIdx);
    m.elementToEdge.set(lineEl, edgeIdx);
    m.elementToEdge.set(hitEl, edgeIdx);
    m.elementToEdge.set(labelEl, edgeIdx);

    const slot: EdgeSlot = { groupEl, lineEl, hitEl, labelEl, edgeIdx, flags: 0 };
    m.edgeSlots.set(edgeIdx, slot);
    return slot;
  }

  private updateEdgeContent(slot: EdgeSlot, edgeIdx: number): void {
    const m = this.mounted;
    if (m === null) return;
    const { graph } = m;
    const { topology } = graph;

    const d = topology.edgePath[edgeIdx];
    slot.lineEl.setAttribute('d', d);
    slot.hitEl.setAttribute('d', d);

    const calls = graph.callCount[edgeIdx];
    const avg = graph.edgeAvgMs[edgeIdx];
    slot.labelEl.style.left = `${topology.labelX[edgeIdx]}px`;
    slot.labelEl.style.top = `${topology.labelY[edgeIdx]}px`;
    slot.labelEl.textContent = `${calls}×${avg > 0 ? ` · ${formatDuration(avg)}` : ''}`;

    const strokeW = Math.max(1.5, Math.min(6, 1.5 + Math.log2(Math.max(1, calls)) * 0.8));
    slot.lineEl.style.strokeWidth = `${strokeW.toFixed(1)}px`;
    slot.lineEl.setAttribute('marker-end', 'url(#l2t-arrow-default)');
  }

  private readFlags(): void {
    const m = this.mounted;
    if (m === null) return;
    const { state } = m.ctx.store;
    const { graph } = m;

    m.selectedNodes = nodesOfSpans(graph, state.selection.ids);
    m.selectedEdges = edgesOfSpans(graph, state.selection.ids);
    m.hoveredNodes = nodesOfSpans(graph, state.hover?.ids ?? null);
    m.hoveredEdges = edgesOfSpans(graph, state.hover?.ids ?? null);

    if (m.matchedFor !== state.matched || state.matched === null) {
      m.matchedNodes = nodesMatched(graph, state.matched);
      m.matchedEdges = edgesMatched(graph, state.matched);
      m.matchedFor = state.matched;
    }

    const hasSelection = m.selectedNodes.size > 0 || m.selectedEdges.size > 0;

    // Node flags
    for (const [u, slot] of m.nodeSlots) {
      const isSelected = m.selectedNodes.has(u);
      const isHovered = m.hoveredNodes.has(u);
      const isFailed = graph.errorCount[u] > 0;
      const isDimmed = m.matchedNodes !== null && m.matchedNodes[u] === 0;
      const isContext = hasSelection && !isSelected && !this.isNodeNeighborOfSelection(u);
      const isOutside = graph.spanCount[u] === 0;

      slot.el.classList.toggle(styles.selected, isSelected);
      slot.el.classList.toggle(styles.hovered, isHovered);
      slot.el.classList.toggle(styles.failed, isFailed);
      slot.el.classList.toggle(styles.dimmed, isDimmed);
      slot.el.classList.toggle(styles.context, isContext);
      slot.el.classList.toggle(styles.outsideWindow, isOutside);
    }

    // Edge flags
    for (const [e, slot] of m.edgeSlots) {
      const isSelected = m.selectedEdges.has(e);
      const isHovered = m.hoveredEdges.has(e);
      const isFailed = graph.edgeErrorCount[e] > 0;
      const isDimmed = m.matchedEdges !== null && m.matchedEdges[e] === 0;
      const isContext = hasSelection && !isSelected;
      const isAsync = graph.topology.pattern[e] === 2; // EdgePattern.Async

      slot.lineEl.classList.toggle(styles.edgeLineSelected, isSelected);
      slot.lineEl.classList.toggle(styles.edgeLineHovered, isHovered);
      slot.lineEl.classList.toggle(styles.edgeLineError, isFailed);
      slot.lineEl.classList.toggle(styles.edgeLineDimmed, isDimmed);
      slot.lineEl.classList.toggle(styles.edgeLineContext, isContext);
      slot.lineEl.classList.toggle(styles.edgeLineAsync, isAsync);

      slot.labelEl.classList.toggle(styles.edgeLabelSelected, isSelected);
      slot.labelEl.classList.toggle(styles.edgeLabelHovered, isHovered);
      slot.labelEl.classList.toggle(styles.edgeLabelError, isFailed);

      const marker = isSelected || isHovered ? 'url(#l2t-arrow-selected)' : isFailed ? 'url(#l2t-arrow-error)' : 'url(#l2t-arrow-default)';
      slot.lineEl.setAttribute('marker-end', marker);
    }
  }

  private isNodeNeighborOfSelection(u: number): boolean {
    const m = this.mounted;
    if (m === null) return false;
    for (let e = 0; e < m.graph.topology.edgeCount; e++) {
      if (m.selectedEdges.has(e) && (m.graph.topology.source[e] === u || m.graph.topology.target[e] === u)) {
        return true;
      }
      if (m.selectedNodes.has(m.graph.topology.source[e]) && m.graph.topology.target[e] === u) return true;
      if (m.selectedNodes.has(m.graph.topology.target[e]) && m.graph.topology.source[e] === u) return true;
    }
    return false;
  }

  private applyCamera(): void {
    const m = this.mounted;
    if (m === null) return;
    const { x, y, scale } = m.camera;
    m.world.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
  }

  // ---------------------------------------------------------------------------
  // Viewport & Selection Actions
  // ---------------------------------------------------------------------------

  private fitAll(): void {
    const m = this.mounted;
    if (m === null || m.width === 0 || m.height === 0) return;
    const bounds = { x: 0, y: 0, width: m.graph.topology.width, height: m.graph.topology.height };
    m.camera = fitBounds2D(bounds, m.width, m.height, 40, 1.0);
    m.frame.mark(Dirty.Camera);
  }

  private zoomStep(factor: number): void {
    const m = this.mounted;
    if (m === null || m.width === 0) return;
    m.camera = zoomCamera2DAt(m.camera, m.width / 2, m.height / 2, factor);
    m.frame.mark(Dirty.Camera);
    m.ctx.refreshCommands();
  }

  private focusOnNode(nodeIdx: number): void {
    const m = this.mounted;
    if (m === null || m.width === 0 || nodeIdx >= m.graph.topology.nodeCount) return;
    const nx = m.graph.topology.nodeX[nodeIdx];
    const ny = m.graph.topology.nodeY[nodeIdx];
    const bounds = { x: nx - 60, y: ny - 40, width: NODE_WIDTH + 120, height: NODE_HEIGHT + 80 };
    m.camera = fitBounds2D(bounds, m.width, m.height, 20, 1.3);
    m.frame.mark(Dirty.Camera);
    m.ctx.refreshCommands();
  }

  private selectedNodeIdx(): number {
    const m = this.mounted;
    if (m === null || m.selectedNodes.size === 0) return -1;
    return m.selectedNodes.values().next().value ?? -1;
  }

  private selectNode(nodeIdx: number): void {
    const m = this.mounted;
    if (m === null) return;
    const { ids, primary } = spansOfNode(m.graph, nodeIdx);
    m.ctx.store.setSelection(ids, { origin: m.ctx.origin, primary: primary ?? undefined, key: `node:${nodeIdx}` });
  }

  private selectEdge(edgeIdx: number): void {
    const m = this.mounted;
    if (m === null) return;
    const { ids, primary } = spansOfEdge(m.graph, edgeIdx);
    m.ctx.store.setSelection(ids, { origin: m.ctx.origin, primary: primary ?? undefined, key: `edge:${edgeIdx}` });
  }

  // ---------------------------------------------------------------------------
  // Input Handling
  // ---------------------------------------------------------------------------

  private targetAt(x: number, y: number): { type: 'node' | 'edge'; idx: number } | null {
    const m = this.mounted;
    if (m === null) return null;
    const rootNode = m.root.getRootNode() as Document | ShadowRoot;
    const el = rootNode.elementFromPoint ? rootNode.elementFromPoint(x, y) : document.elementFromPoint(x, y);
    if (!el) return null;

    let cur: Element | null = el;
    while (cur && cur !== m.root) {
      const nodeIdx = m.elementToNode.get(cur);
      if (nodeIdx !== undefined) return { type: 'node', idx: nodeIdx };
      const edgeIdx = m.elementToEdge.get(cur);
      if (edgeIdx !== undefined) return { type: 'edge', idx: edgeIdx };
      cur = cur.parentElement;
    }
    return null;
  }

  private onInputAction(action: InputAction): void {
    const m = this.mounted;
    if (m === null) return;

    switch (action.kind) {
      case InputActionKind.Pan:
        m.camera = panCamera2D(m.camera, action.dx, action.dy);
        m.frame.mark(Dirty.Camera);
        break;

      case InputActionKind.Zoom:
        // factor < 1 zooms in
        m.camera = zoomCamera2DAt(m.camera, action.x, action.y, 1 / action.factor);
        m.frame.mark(Dirty.Camera);
        m.ctx.refreshCommands();
        break;

      case InputActionKind.Click: {
        const rect = m.root.getBoundingClientRect();
        const hit = this.targetAt(rect.left + action.x, rect.top + action.y);
        if (hit?.type === 'node') this.selectNode(hit.idx);
        else if (hit?.type === 'edge') this.selectEdge(hit.idx);
        else if (m.ctx.store.state.selection.ids.size > 0) {
          m.ctx.store.setSelection([], { origin: m.ctx.origin });
        }
        break;
      }

      case InputActionKind.DoubleClick: {
        const rect = m.root.getBoundingClientRect();
        const hit = this.targetAt(rect.left + action.x, rect.top + action.y);
        if (hit?.type === 'node') this.focusOnNode(hit.idx);
        else this.fitAll();
        break;
      }

      case InputActionKind.Hover: {
        const rect = m.root.getBoundingClientRect();
        const hit = this.targetAt(rect.left + action.x, rect.top + action.y);
        if (hit === null) {
          this.leaveHover();
          return;
        }

        if (m.hoverTarget?.type === hit.type && m.hoverTarget?.idx === hit.idx) return;
        m.hoverTarget = hit;

        if (hit.type === 'node') {
          const u = hit.idx;
          const { ids, primary } = spansOfNode(m.graph, u);
          m.ctx.store.setHover(ids, { origin: m.ctx.origin, primary: primary ?? undefined, key: `node:${u}` });

          const screenPos = worldToScreen(m.camera, m.graph.topology.nodeX[u], m.graph.topology.nodeY[u]);
          m.ctx.hover({
            key: `${m.generation}:node:${u}`,
            anchor: {
              x: screenPos.x,
              y: screenPos.y,
              w: NODE_WIDTH * m.camera.scale,
              h: NODE_HEIGHT * m.camera.scale,
            },
            bounds: { width: m.width, height: m.height },
            info: () => describeNode(m.graph, u),
          });
        } else {
          const e = hit.idx;
          const { ids, primary } = spansOfEdge(m.graph, e);
          m.ctx.store.setHover(ids, { origin: m.ctx.origin, primary: primary ?? undefined, key: `edge:${e}` });

          const screenPos = worldToScreen(m.camera, m.graph.topology.labelX[e], m.graph.topology.labelY[e]);
          m.ctx.hover({
            key: `${m.generation}:edge:${e}`,
            anchor: {
              x: screenPos.x - 20,
              y: screenPos.y - 10,
              w: 40,
              h: 20,
            },
            bounds: { width: m.width, height: m.height },
            info: () => describeEdge(m.graph, e),
          });
        }
        break;
      }

      case InputActionKind.HoverEnd:
        this.leaveHover();
        break;

      case InputActionKind.KeyDown:
        this.onKeyDown(action.key);
        break;
    }
  }

  private leaveHover(): void {
    const m = this.mounted;
    if (m === null || m.hoverTarget === null) return;
    m.hoverTarget = null;
    m.ctx.store.setHover(null, { origin: m.ctx.origin });
    m.ctx.hover(null);
  }

  private onKeyDown(key: Key): void {
    const m = this.mounted;
    if (m === null) return;
    const cur = this.selectedNodeIdx();

    switch (key) {
      case Key.ArrowUp: {
        const next = neighbourNode(m.graph, cur, 'up');
        if (next >= 0) this.selectNode(next);
        break;
      }
      case Key.ArrowDown: {
        const next = neighbourNode(m.graph, cur, 'down');
        if (next >= 0) this.selectNode(next);
        break;
      }
      case Key.ArrowLeft: {
        const next = neighbourNode(m.graph, cur, 'left');
        if (next >= 0) this.selectNode(next);
        break;
      }
      case Key.ArrowRight: {
        const next = neighbourNode(m.graph, cur, 'right');
        if (next >= 0) this.selectNode(next);
        break;
      }
      case Key.Plus:
        this.zoomStep(1.2);
        break;
      case Key.Minus:
        this.zoomStep(1 / 1.2);
        break;
      case Key.Zero:
        this.fitAll();
        break;
      case Key.Enter:
      case Key.Space:
        if (cur >= 0) this.focusOnNode(cur);
        break;
      case Key.Escape:
        if (m.ctx.store.state.selection.ids.size > 0) {
          m.ctx.store.setSelection([], { origin: m.ctx.origin });
        } else {
          this.fitAll();
        }
        break;
    }
  }
}

/** The Service Graph view definition for registration. */
export const serviceDefinition: ViewDefinition = {
  id: 'service',
  label: 'Service graph',
  renderers: ['dom'],
  capabilities: { legend: false },
  create: () => new ServiceView(),
};
