/**
 * The flame graph as a view: the trace folded into boxes by call path, drawn with the DOM.
 *
 * `model.ts` decides what the boxes are and where they go; this class gives them a surface. One
 * native scroller (vertical only) holds a stage whose boxes are absolutely positioned elements, drawn
 * only for the rows in view and only when wide enough to see, and kept in a pool so that a scroll, a
 * resize or a new focus rewrites a few styles instead of rebuilding elements. Only the DOM draws
 * here: there is no second painter.
 *
 * What it shares through the store: a click selects every span of the box (`Target.key` names the
 * box), a hover does the same, the filter dims the boxes none of whose spans passed, the time window
 * limits what the weights count, and a selection or hover made elsewhere lights the box that holds
 * those spans. What is its own: the focus (the box that fills the width), kept across tabs with
 * `getState`. Collapsed spans are ignored, as the store documents.
 *
 * Keys: arrows move the selection (up to the parent box, down to the heaviest child, left and right
 * to the neighbours), `F` focuses the selected box, Escape leaves the focus, or else clears the
 * selection. A double click focuses the box.
 */

import { Slice, touches, formatDuration, type ChangeSet, type SpanId } from '../../core.ts';
import * as a11yStyles from '../../kit/a11y.css.ts';
import type { ViewCommand } from '../../kit/commands.ts';
import { h } from '../../kit/dom.ts';
import { getFrameScheduler, type FrameHandle } from '../../kit/scheduler.ts';
import { cssVariableName } from '../../kit/theme/theme.ts';
import type { RendererKind, TraceView, ViewContext, ViewDefinition } from '../../kit/view.ts';
import {
  boxName, boxesMatched, boxesOfSpans, describeBox, flameTree, layoutFlame, neighbour, spansOfBox,
  type FlameLayout, type FlameTree,
} from './model.ts';
import * as styles from './view.css.ts';

/** Height of a row, px. */
const ROW_HEIGHT = 20;
/** A box narrower than this (px) carries no label. */
const MIN_LABEL_WIDTH = 32;
/** Rows drawn beyond the edge of the view, so a scroll shows boxes at once. */
const OVERSCAN_ROWS = 4;

/** What the next frame has to do. */
enum Dirty {
  /** The tree, the focus or the width changed: lay out again. */
  Layout = 1,
  /** The scroll position changed. */
  View = 2,
  /** The selection, the hover or the filter changed: read them again. */
  Flags = 4,
}

/** What a drawn box shows besides its colour; one class each. */
enum Flag {
  Selected = 1,
  Hovered = 2,
  Dimmed = 4,
  Context = 8,
  Failed = 16,
}
const FLAG_CLASSES: ReadonlyArray<readonly [Flag, string]> = [
  [Flag.Selected, styles.selected],
  [Flag.Hovered, styles.hovered],
  [Flag.Dimmed, styles.dimmed],
  [Flag.Context, styles.context],
  [Flag.Failed, styles.failed],
];
const KIND_CLASSES = [styles.kind.unspecified, styles.kind.internal, styles.kind.server, styles.kind.client, styles.kind.producer, styles.kind.consumer];

/** A drawn box. */
interface Slot {
  readonly el: HTMLElement;
  readonly box: number;
  x: number;
  w: number;
  flags: number;
  labelled: boolean;
  /** The frame that last kept it. */
  seen: number;
}

/** What the view keeps while it is mounted. */
interface Mounted {
  readonly ctx: ViewContext;
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  readonly note: HTMLElement;
  readonly live: HTMLElement;
  readonly frame: FrameHandle;
  readonly observer: ResizeObserver;
  readonly slots: Map<number, Slot>;
  readonly slotOf: WeakMap<Element, Slot>;
  readonly pool: HTMLElement[];
  tree: FlameTree;
  layout: FlameLayout;
  focus: number;
  generation: number;
  frameNo: number;
  width: number;
  height: number;
  hoverBox: number;
  selected: ReadonlySet<number>;
  hovered: ReadonlySet<number>;
  matched: Uint8Array | null;
  matchedFor: unknown;
  liveText: string;
}

/** What is kept when the view is hidden. */
interface SavedState {
  readonly generation: number;
  readonly focus: number;
}

function isSavedState(value: unknown): value is SavedState {
  if (typeof value !== 'object' || value === null) return false;
  const { generation, focus } = value as Partial<SavedState>;
  return typeof generation === 'number' && typeof focus === 'number';
}

/** The flame graph view. */
export class FlameView implements TraceView {
  readonly renderer: RendererKind = 'dom';
  private mounted: Mounted | null = null;

  mount(surface: HTMLElement, ctx: ViewContext): void {
    if (this.mounted !== null) return;
    const tree = ctx.store.derive(flameTree);
    const stage = h('div', { class: styles.stage });
    stage.style.setProperty(cssVariableName(styles.rowHeightVar), `${ROW_HEIGHT}px`);
    const note = h('div', { class: styles.empty }, 'No spans to show.');
    const live = h('div', { class: a11yStyles.visuallyHidden, 'aria-live': 'polite' });
    const root = h('div', { class: styles.root, part: 'flame', tabindex: 0, role: 'application', 'aria-label': 'Flame graph' }, stage, note);
    surface.append(root, live);

    const frame = getFrameScheduler().register({ paint: (dirty) => this.paint(dirty) });
    const observer = new ResizeObserver(() => {
      const m = this.mounted;
      if (m === null) return;
      const { clientWidth, clientHeight } = m.root;
      const resized = clientWidth !== m.width;
      m.width = clientWidth;
      m.height = clientHeight;
      m.frame.mark(resized ? Dirty.Layout : Dirty.View);
    });
    this.mounted = {
      ctx, root, stage, note, live, frame, observer, tree,
      slots: new Map(), slotOf: new WeakMap(), pool: [],
      layout: layoutFlame(tree, -1, 0), focus: -1, generation: ctx.store.state.data.generation,
      frameNo: 0, width: 0, height: 0, hoverBox: -1,
      selected: new Set(), hovered: new Set(), matched: null, matchedFor: null, liveText: '',
    };

    root.addEventListener('scroll', () => {
      this.leaveHover();
      frame.mark(Dirty.View);
    });
    root.addEventListener('pointermove', (event) => this.onPointer(event));
    root.addEventListener('pointerleave', () => this.leaveHover());
    root.addEventListener('click', (event) => this.onClick(event));
    root.addEventListener('dblclick', (event) => {
      const slot = this.slotAt(event);
      if (slot !== undefined) this.focusBox(slot.box);
    });
    root.addEventListener('keydown', (event) => this.onKey(event));
    observer.observe(root);
    frame.mark(Dirty.Layout | Dirty.Flags);
  }

  unmount(): void {
    const m = this.mounted;
    if (m === null) return;
    this.mounted = null;
    m.observer.disconnect();
    m.frame.dispose();
    if (m.hoverBox >= 0) m.ctx.store.setHover(null, { origin: m.ctx.origin });
    m.root.remove();
    m.live.remove();
    m.ctx.hover(null);
  }

  update(change: ChangeSet): void {
    const m = this.mounted;
    if (m === null) return;
    if (touches(change, Slice.Data)) {
      m.generation = m.ctx.store.state.data.generation;
      m.focus = -1;
      m.hoverBox = -1;
      m.ctx.hover(null);
    }
    if (touches(change, Slice.Data | Slice.Window)) {
      m.tree = m.ctx.store.derive(flameTree);
      m.frame.mark(Dirty.Layout | Dirty.Flags);
    }
    else if (touches(change, Slice.Selection | Slice.Hover | Slice.Filter)) m.frame.mark(Dirty.Flags);
    if (touches(change, Slice.Selection | Slice.Data)) m.ctx.refreshCommands();
  }

  optionsChanged(): void {
    // nothing to configure
  }

  themeChanged(): void {
    // the stylesheet follows the tokens by itself
  }

  commands(): readonly ViewCommand[] {
    const m = this.mounted;
    if (m === null) return [];
    return [
      // the toolbar draws the well-known ids as symbols: + focuses the selected box, − goes up one box
      { id: 'zoom-in', label: 'Focus on the selected box', run: () => this.focusSelected(), enabled: () => this.selectedBox() >= 0 && this.selectedBox() !== m.focus },
      { id: 'zoom-out', label: 'Focus on the parent box', run: () => this.focusBox(m.tree.parent[m.focus]), enabled: () => m.focus >= 0 },
      {
        id: 'zoom-reset', label: 'Show the whole trace', run: () => this.focusBox(-1), enabled: () => m.focus >= 0,
        readout: () => m.focus < 0 ? 'Whole trace' : boxName(m.tree, m.focus),
      },
    ];
  }

  focus(): void {
    this.mounted?.root.focus({ preventScroll: true });
  }

  reveal(id: SpanId): void {
    const m = this.mounted;
    const indexed = m?.tree.index.spans.get(id);
    if (m === null || indexed === undefined) return;
    this.showBox(m.tree.boxOfRow[indexed.idx]);
  }

  getState(): unknown {
    const m = this.mounted;
    return m === null ? null : { generation: m.generation, focus: m.focus } satisfies SavedState;
  }

  setState(state: unknown): void {
    const m = this.mounted;
    if (m === null || !isSavedState(state) || state.generation !== m.generation || state.focus >= m.tree.count) return;
    this.focusBox(state.focus);
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  private paint(dirty: number): number | void {
    const m = this.mounted;
    if (m === null) return;
    if (m.width === 0) {
      m.width = m.root.clientWidth;
      m.height = m.root.clientHeight;
    }
    if (m.width === 0) return dirty; // hidden or not laid out yet: try again when something marks it

    if ((dirty & Dirty.Layout) !== 0) this.relayout();
    if ((dirty & Dirty.Flags) !== 0) this.readFlags();
    this.reconcile();
  }

  private relayout(): void {
    const m = this.mounted;
    if (m === null) return;
    m.tree = m.ctx.store.derive(flameTree);
    if (m.focus >= m.tree.count) m.focus = -1;
    m.layout = layoutFlame(m.tree, m.focus, m.width);
    m.stage.style.height = `${m.layout.rows * ROW_HEIGHT}px`;
    m.note.hidden = m.layout.n > 0;
    m.matchedFor = null;
    m.ctx.refreshCommands();
  }

  /** Read the selection, the hover and the filter of the store as sets of boxes. */
  private readFlags(): void {
    const m = this.mounted;
    if (m === null) return;
    const { state } = m.ctx.store;
    m.selected = boxesOfSpans(m.tree, state.selection.ids);
    m.hovered = boxesOfSpans(m.tree, state.hover?.ids ?? null);
    if (m.matchedFor !== state.matched || state.matched === null) {
      m.matched = boxesMatched(m.tree, state.matched);
      m.matchedFor = state.matched;
    }

    // a screen reader hears what was selected
    const box = this.selectedBox();
    const text = box < 0 ? '' : `${boxName(m.tree, box)}, ${formatDuration(m.tree.weight[box])}, ${m.tree.spans[box]} spans`;
    if (text !== m.liveText) {
      m.liveText = text;
      m.live.textContent = text;
    }
  }

  /** Make the drawn boxes the ones in view: add, move and recolour what changed, and pool the rest. */
  private reconcile(): void {
    const m = this.mounted;
    if (m === null) return;
    const { layout, tree } = m;
    const first = m.root.scrollTop - OVERSCAN_ROWS * ROW_HEIGHT;
    const last = m.root.scrollTop + m.height + OVERSCAN_ROWS * ROW_HEIGHT;
    const frameNo = ++m.frameNo;
    const focusDepth = m.focus < 0 ? -1 : tree.depth[m.focus];

    for (let i = 0; i < layout.n; i++) {
      const b = layout.box[i];
      const y = tree.depth[b] * ROW_HEIGHT;
      if (y < first || y > last) continue;
      let slot = m.slots.get(b);
      if (slot === undefined) slot = this.acquire(b, y);
      slot.seen = frameNo;

      const x = layout.x[i];
      const w = layout.w[i];
      if (slot.x !== x) { slot.el.style.left = `${x}px`; slot.x = x; }
      if (slot.w !== w) { slot.el.style.width = `${w}px`; slot.w = w; }
      const labelled = w >= MIN_LABEL_WIDTH;
      if (labelled !== slot.labelled) {
        slot.el.textContent = labelled ? boxName(tree, b) : '';
        slot.labelled = labelled;
      }

      let flags = tree.failed[b] === 1 ? Flag.Failed : 0;
      if (m.selected.has(b)) flags |= Flag.Selected;
      if (m.hovered.has(b)) flags |= Flag.Hovered;
      if (m.matched !== null && m.matched[b] === 0) flags |= Flag.Dimmed;
      if (tree.depth[b] < focusDepth) flags |= Flag.Context;
      if (flags !== slot.flags) {
        for (const [flag, name] of FLAG_CLASSES) {
          if (((flags ^ slot.flags) & flag) !== 0) slot.el.classList.toggle(name, (flags & flag) !== 0);
        }
        slot.flags = flags;
      }
    }

    for (const [b, slot] of m.slots) {
      if (slot.seen === frameNo) continue;
      slot.el.remove();
      m.pool.push(slot.el);
      m.slots.delete(b);
    }
  }

  private acquire(box: number, y: number): Slot {
    const m = this.mounted as Mounted;
    const el = m.pool.pop() ?? h('div');
    el.className = `${styles.box} ${KIND_CLASSES[Math.min(m.tree.index.table.kind[m.tree.row[box]], KIND_CLASSES.length - 1)]}`;
    el.textContent = '';
    el.style.top = `${y}px`;
    const slot: Slot = { el, box, x: Number.NaN, w: Number.NaN, flags: 0, labelled: false, seen: 0 };
    m.slots.set(box, slot);
    m.slotOf.set(el, slot);
    m.stage.append(el);
    return slot;
  }

  // ---------------------------------------------------------------------------
  // Boxes
  // ---------------------------------------------------------------------------

  /** The box that holds the primary span of the selection, or -1. */
  private selectedBox(): number {
    const m = this.mounted;
    if (m === null) return -1;
    const primary = m.ctx.store.state.selection.primary;
    const indexed = primary === null ? undefined : m.tree.index.spans.get(primary);
    return indexed === undefined ? -1 : m.tree.boxOfRow[indexed.idx];
  }

  private selectBox(box: number): void {
    const m = this.mounted;
    if (m === null) return;
    const { ids, primary } = spansOfBox(m.tree, box);
    m.ctx.store.setSelection(ids, { origin: m.ctx.origin, primary, key: String(box) });
  }

  /** Make a box fill the width (`-1` for the whole trace). */
  private focusBox(box: number): void {
    const m = this.mounted;
    if (m === null || box === m.focus) return;
    m.focus = box;
    this.leaveHover();
    m.root.scrollTop = 0;
    m.frame.mark(Dirty.Layout);
  }

  private focusSelected(): void {
    const box = this.selectedBox();
    if (box >= 0) this.focusBox(box);
  }

  /** Bring a box on screen: focus it when it is not drawn (too narrow, or outside the focus), then scroll to its row. */
  private showBox(box: number): void {
    const m = this.mounted;
    if (m === null) return;
    if (m.width === 0) m.width = m.root.clientWidth;
    if (m.layout.slotOfBox[box] < 0 && m.layout.slotOfBox.length === m.tree.count) {
      m.focus = box;
      this.relayout();
    }
    const y = m.tree.depth[box] * ROW_HEIGHT;
    if (y < m.root.scrollTop || y + ROW_HEIGHT > m.root.scrollTop + m.height) {
      m.root.scrollTop = Math.max(0, y - m.height / 2);
    }
    m.frame.mark(Dirty.View | Dirty.Flags);
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  private slotAt(event: Event): Slot | undefined {
    const target = event.target;
    return this.mounted !== null && target instanceof Element ? this.mounted.slotOf.get(target) : undefined;
  }

  private onClick(event: MouseEvent): void {
    const m = this.mounted;
    if (m === null) return;
    const slot = this.slotAt(event);
    if (slot !== undefined) this.selectBox(slot.box);
    else if (m.ctx.store.state.selection.ids.size > 0) m.ctx.store.setSelection([], { origin: m.ctx.origin });
  }

  private onPointer(event: PointerEvent): void {
    const m = this.mounted;
    if (m === null) return;
    const slot = this.slotAt(event);
    if (slot === undefined) {
      this.leaveHover();
      return;
    }
    if (slot.box === m.hoverBox) return;
    m.hoverBox = slot.box;
    const { ids, primary } = spansOfBox(m.tree, slot.box);
    m.ctx.store.setHover(ids, { origin: m.ctx.origin, primary, key: String(slot.box) });
    const { tree } = m;
    m.ctx.hover({
      key: `${m.generation}:${slot.box}:${tree.weight[slot.box]}`,
      anchor: { x: slot.x, y: tree.depth[slot.box] * ROW_HEIGHT - m.root.scrollTop, w: slot.w, h: ROW_HEIGHT },
      bounds: { width: m.root.clientWidth, height: m.root.clientHeight },
      info: () => describeBox(tree, slot.box),
    });
  }

  private leaveHover(): void {
    const m = this.mounted;
    if (m === null || m.hoverBox < 0) return;
    m.hoverBox = -1;
    m.ctx.store.setHover(null, { origin: m.ctx.origin });
    m.ctx.hover(null);
  }

  private onKey(event: KeyboardEvent): void {
    const m = this.mounted;
    if (m === null || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    const { tree } = m;
    const box = this.selectedBox();
    let next = -1;
    switch (event.key) {
      case 'ArrowUp': next = box < 0 ? -1 : neighbour(tree, box, 'parent'); break;
      case 'ArrowDown': next = box < 0 ? (tree.children.length > 0 ? tree.children[tree.childOff[tree.count]] : -1) : neighbour(tree, box, 'child'); break;
      case 'ArrowLeft': next = box < 0 ? -1 : neighbour(tree, box, 'previous'); break;
      case 'ArrowRight': next = box < 0 ? -1 : neighbour(tree, box, 'next'); break;
      case 'f': case 'F':
        if (box < 0) return;
        this.focusSelected();
        event.preventDefault();
        return;
      case 'Escape':
        if (m.focus >= 0) this.focusBox(-1);
        else if (m.ctx.store.state.selection.ids.size > 0) m.ctx.store.setSelection([], { origin: m.ctx.origin });
        else return;
        event.preventDefault();
        return;
      default: return;
    }
    event.preventDefault();
    if (next < 0) return;
    this.selectBox(next);
    this.showBox(next);
  }
}

/** The flame graph, as the element lists it. */
export const flameDefinition: ViewDefinition = {
  id: 'flame',
  label: 'Flame graph',
  renderers: ['dom'],
  capabilities: { legend: true },
  create: () => new FlameView(),
};
