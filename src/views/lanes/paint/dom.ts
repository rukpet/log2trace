/**
 * Lanes painter for the DOM.
 *
 * The controller's frame plan, turned into elements. Bars live in a pool of elements that is bounded
 * by the plan's run budget (`MAX_BARS`): a bar element is reused for the run that starts with the
 * same item, so panning only moves the bars still in view and zooming rewrites their extents, while
 * a bar that left the view is hidden and kept for the next one. What each element shows is cached per
 * slot and written only when it changes: a pan writes one transform per bar, a hover or selection
 * toggles classes (the hover without even planning the frame again), a scroll moves the lanes.
 *
 * Besides the bars a frame has a lane header per visible lane in the gutter (`treeitem`s of a `tree`,
 * so a screen reader and find-in-page see them), an `<svg>` with an area path and a path of error ticks
 * for each visible summary row (a collapsed lane, the overflow row of a capped one), the ruler and its
 * grid lines. That is a few elements per visible lane on top of the bars, so the DOM stays at a few
 * thousand nodes however many spans the trace has.
 *
 * Bar positions come from the plan, clipped in JS to just outside the plot: CSS lengths in the
 * hundreds of millions of pixels (a bar at deep zoom) would saturate the layout engine's limit and
 * make the bar disappear. Bars are `aria-hidden`; picking is geometric, through the controller.
 *
 * Input is not handled here: the element's native scroller sits above the layer and its events go
 * through the controller's hit test.
 */

import { h } from '../../../kit/dom.ts';
import { Dirty, type FrameHandle, type FrameScheduler } from '../../../kit/scheduler.ts';
import { cssVariableName } from '../../../kit/theme/theme.ts';
import { clearOnFontLoad, type TextMeter } from '../../../kit/text-cache.ts';
import type { LanesController } from '../controller.ts';
import { HitPart } from '../model/hit.ts';
import { LanesDirty } from '../model/interaction.ts';
import { LaneMode } from '../model/layout.ts';
import { LanesFramePlan, MAX_BARS, RunFlag, SummaryKind } from '../model/plan.ts';
import type * as DomStyles from './dom.css.ts';

const SCENE_BITS = Dirty.Size | Dirty.Theme | Dirty.Rows | Dirty.Scroll | Dirty.Camera | Dirty.Selection;
const OVERLAY_BITS = SCENE_BITS | Dirty.Hover;

/** Bars narrower than this have square corners. */
const SHARP_BELOW_PX = 6;
/** The state bit of a bar narrower than {@link SHARP_BELOW_PX}; above the bits of {@link RunFlag}. */
const SHARP = 1 << 10;
/** The bits of {@link RunFlag} a bar shows as a class, besides the hover. */
const PLAN_STATE_MASK = RunFlag.Error | RunFlag.Dimmed | RunFlag.Related | RunFlag.Faded | RunFlag.Ghost | RunFlag.Merged | RunFlag.Selected;

/** Idle bar elements kept (at least) when the pool gives some back to the document. */
const KEEP_IDLE_BARS = 256;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The class names of `dom.css.ts`; passed in, so this module does not import the stylesheet and runs under `node:test`. */
export type DomClasses = typeof DomStyles;

/** Counters for the harness and the tests: what the painter did. */
export interface PainterStats {
  /** Full redraws so far: a plan was built and written. */
  scenes: number;
  /** Cheap redraws so far: only the hover classes. */
  overlays: number;
  /** Runs (bars, merged or not) drawn by the last full redraw. */
  bars: number;
  /** Bar elements in the document, shown or idle. */
  barElements: number;
  /** Lane headers drawn by the last full redraw. */
  headers: number;
  /** Summary rows drawn by the last full redraw. */
  summaries: number;
  /** Writes of a bar's position, size, colour or label so far. */
  geometryWrites: number;
  /** Class toggles on bars so far. */
  classWrites: number;
}

/** What the painter is given when it is mounted. */
export interface PainterContext {
  readonly controller: LanesController;
  /** The element to draw into. It is positioned (`position: relative`) and clips its content. */
  readonly host: HTMLElement;
  /** Caches text widths; shared, and cleared by the painter when fonts load. */
  readonly meter: TextMeter;
  /** Fallback CSS font-family when `getComputedStyle` is unavailable (tests). */
  readonly fontFamily?: string;
  readonly scheduler: FrameScheduler;
  /** The host has (a new) size, in CSS px. Called before the painter draws at that size. */
  readonly onSize: (width: number, height: number) => void;
}

/** A mounted lanes DOM painter. */
export interface LanesPainter {
  readonly stats: PainterStats;
  /** Say what changed, as {@link LanesDirty} bits; the painter draws on the next frame. */
  mark(dirty: number): void;
  /** The theme tokens may have changed; re-read the computed font and repaint. */
  refreshTheme(): void;
  /** Remove everything the painter added to the host and stop its listeners. */
  dispose(): void;
}

function toSurfaceDirty(bits: number): number {
  let out = 0;
  if (bits & (LanesDirty.Lanes | LanesDirty.Filter)) out |= Dirty.Rows;
  if (bits & LanesDirty.Scroll) out |= Dirty.Scroll;
  if (bits & LanesDirty.Camera) out |= Dirty.Camera;
  if (bits & LanesDirty.Selection) out |= Dirty.Selection;
  if (bits & LanesDirty.Hover) out |= Dirty.Hover;
  if (bits & LanesDirty.Theme) out |= Dirty.Theme;
  if (bits & LanesDirty.Size) out |= Dirty.Size;
  return out;
}

/** One bar element and what was last written to it. */
interface BarSlot {
  readonly el: HTMLElement;
  /** The first item of the run it shows; -1 while idle and never used. */
  first: number;
  items: number;
  x: number;
  y: number;
  w: number;
  kind: number;
  /** Class bits in force: {@link RunFlag} bits, hover and {@link SHARP}. */
  state: number;
  label: string;
  pad: number;
  /** The frame that last used it. */
  used: number;
  idle: boolean;
}

/** One lane header and what was last written to it. */
interface HeaderSlot {
  readonly root: HTMLElement;
  readonly gutter: HTMLElement;
  readonly content: HTMLElement;
  readonly chevron: HTMLElement;
  readonly name: HTMLElement;
  readonly stats: HTMLElement;
  lane: number;
  y: number;
  height: number;
  offset: number;
  mode: number;
  tall: boolean;
  statsText: string;
  stamp: number;
  hovered: boolean;
  used: number;
}

/** One summary row (an `<svg>`, and the "+N rows" button of an overflow row). */
interface SummarySlot {
  readonly wrap: HTMLElement;
  readonly svg: SVGElement;
  readonly area: SVGElement;
  readonly errors: SVGElement;
  readonly button: HTMLElement;
  lane: number;
  kind: number;
  y: number;
  height: number;
  width: number;
  hidden: number;
  areaPath: string;
  errorPath: string;
  buttonHovered: boolean;
  used: number;
}

interface TickElements {
  readonly grid: HTMLElement;
  readonly line: HTMLElement;
  readonly label: HTMLElement;
  text: string;
}

function svgElement(tag: 'svg' | 'path', ...classes: string[]): SVGElement {
  const element = globalThis.document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const name of classes) element.classList.add(name);
  return element;
}

/** The DOM painter. Create it with {@link mountDomPainter}. */
class LanesDomPainter implements LanesPainter {
  readonly stats: PainterStats = { scenes: 0, overlays: 0, bars: 0, barElements: 0, headers: 0, summaries: 0, geometryWrites: 0, classWrites: 0 };

  private readonly context: PainterContext;
  private readonly styles: DomClasses;
  private readonly kindClasses: readonly string[];
  private readonly stateClasses: ReadonlyArray<readonly [number, string]>;
  private readonly layer: HTMLElement;
  private readonly ruler: HTMLElement;
  private readonly body: HTMLElement;
  private readonly divider: HTMLElement;
  private readonly plot: HTMLElement;
  private readonly hoverBox: HTMLElement;
  private readonly plan = new LanesFramePlan();
  private readonly handle: FrameHandle;
  private readonly observer: ResizeObserver;
  private readonly stopFonts: () => void;

  private readonly bars = new Map<number, BarSlot>();
  private idleBars: BarSlot[] = [];
  /** The slot of each run of the last full redraw. */
  private readonly runSlots: BarSlot[] = [];
  /** The label of each run of the last full redraw, or -1. */
  private readonly runLabel = new Int32Array(MAX_BARS);
  private readonly headers = new Map<number, HeaderSlot>();
  private readonly idleHeaders: HeaderSlot[] = [];
  private readonly summaries = new Map<number, SummarySlot>();
  private readonly idleSummaries: SummarySlot[] = [];
  private readonly ticks: TickElements[] = [];

  private labelFont = '';
  /** The lane model the slots were written for: a new trace invalidates what they cache. */
  private model: unknown = null;
  private frame = 0;
  private stamp = 0;
  private anyHover = false;
  private hoverShown = false;
  private hoverPlaced = '';

  constructor(context: PainterContext, styles: DomClasses) {
    this.context = context;
    this.styles = styles;
    this.kindClasses = [styles.kind.unspecified, styles.kind.internal, styles.kind.server, styles.kind.client, styles.kind.producer, styles.kind.consumer];
    this.stateClasses = [
      [RunFlag.Error, styles.barError],
      [RunFlag.Dimmed, styles.barDimmed],
      [RunFlag.Related, styles.barRelated],
      [RunFlag.Faded, styles.barFaded],
      [RunFlag.Ghost, styles.barGhost],
      [RunFlag.Merged, styles.barMerged],
      [RunFlag.Selected, styles.barSelected],
      [RunFlag.Hovered, styles.barHovered],
      [SHARP, styles.barSharp],
    ];
    this.ruler = h('div', { class: styles.ruler });
    this.divider = h('div', { class: styles.divider });
    this.hoverBox = h('div', { class: [styles.hoverBox, styles.hidden] });
    this.plot = h('div', { class: styles.plot, 'aria-hidden': true }, this.hoverBox);
    this.body = h('div', { class: styles.body, role: 'tree', 'aria-label': 'Lanes' }, h('div', { class: styles.gutterBackground }), this.plot, this.divider);
    this.layer = h('div', { class: styles.layer }, this.body, this.ruler);
    context.host.prepend(this.layer);
    this.setFont(this.readFontFamily());

    this.handle = context.scheduler.register({ paint: (dirty) => this.paint(dirty) });
    this.observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      this.context.onSize(entry.contentRect.width, entry.contentRect.height);
      this.handle.mark(Dirty.Size);
    });
    this.observer.observe(context.host);
    this.stopFonts = clearOnFontLoad(context.meter, { onCleared: () => this.handle.mark(Dirty.Theme) });
    this.handle.mark(Dirty.All);
  }

  mark(dirty: number): void {
    this.handle.mark(toSurfaceDirty(dirty));
  }

  refreshTheme(): void {
    this.context.meter.clear();
    this.setFont(this.readFontFamily());
    this.handle.mark(Dirty.Theme);
  }

  dispose(): void {
    this.observer.disconnect();
    this.stopFonts();
    this.handle.dispose();
    this.layer.remove();
  }

  private readFontFamily(): string {
    return globalThis.getComputedStyle?.(this.layer).fontFamily || this.context.fontFamily || 'system-ui, sans-serif';
  }

  private setFont(fontFamily: string): void {
    this.labelFont = `11px ${fontFamily}`;
  }

  // ---------------------------------------------------------------------------

  private paint(dirty: number): number | void {
    const { controller } = this.context;
    const { layout } = controller;
    if (layout.width === 0 || layout.height === 0) return dirty;

    if ((dirty & Dirty.Size) !== 0) this.applyLayout();
    if ((dirty & (Dirty.Size | Dirty.Theme | Dirty.Rows)) !== 0) this.stamp++;

    if ((dirty & SCENE_BITS) !== 0) {
      if ((dirty & Dirty.Theme) !== 0) this.context.meter.clear();
      const { meter } = this.context;
      const font = this.labelFont;
      controller.buildPlan(this.plan, (text, maxWidth) => meter.fit(text, font, maxWidth));
      if (controller.model !== this.model) this.forgetSlots(controller.model);
      this.writeBars();
      this.writeHeaders();
      this.writeSummaries();
      if ((dirty & (Dirty.Size | Dirty.Theme | Dirty.Camera | Dirty.Rows)) !== 0) this.writeTicks();
      this.stats.scenes++;
      this.stats.bars = this.plan.runCount;
      this.stats.headers = this.plan.headerCount;
      this.stats.summaries = this.plan.summaryCount;
    } else if ((dirty & Dirty.Hover) !== 0) {
      this.applyBarHover();
    }
    if ((dirty & OVERLAY_BITS) !== 0) {
      this.applyHover();
      this.stats.overlays++;
    }
  }

  /** Geometry that depends only on the layout: container sizes, and the custom properties the classes use. */
  private applyLayout(): void {
    const { layout } = this.context.controller;
    this.ruler.style.height = `${layout.headerHeight}px`;
    this.body.style.top = `${layout.headerHeight}px`;
    this.divider.style.transform = `translateX(${layout.plotLeft - 1}px)`;
    const set = (variable: string, value: number): void => this.layer.style.setProperty(cssVariableName(variable), `${value}px`);
    set(this.styles.rowHeightVar, layout.rowHeight);
    set(this.styles.gutterWidthVar, layout.gutterWidth);
    set(this.styles.plotLeftVar, layout.plotLeft);
    set(this.styles.plotWidthVar, layout.plotWidth);
    set(this.styles.barHeightVar, layout.barHeight);
    set(this.styles.summaryHeightVar, layout.summaryHeight);
  }

  /** The trace changed: ids and lane ids in the slots mean something else now. */
  private forgetSlots(model: unknown): void {
    this.model = model;
    for (const slot of this.bars.values()) slot.first = -1;
    for (const slot of this.idleBars) slot.first = -1;
    for (const slot of this.headers.values()) slot.lane = -1;
  }

  // ---------------------------------------------------------------------------
  // Bars
  // ---------------------------------------------------------------------------

  private takeBar(): BarSlot {
    const idle = this.idleBars.pop();
    if (idle !== undefined) {
      idle.el.classList.remove(this.styles.hidden);
      idle.idle = false;
      return idle;
    }
    const el = h('div', { class: [this.styles.bar, this.kindClasses[0]], 'data-part': 'bar' });
    this.plot.append(el);
    this.stats.barElements++;
    return { el, first: -1, items: 0, x: Number.NaN, y: Number.NaN, w: Number.NaN, kind: 0, state: 0, label: '', pad: Number.NaN, used: 0, idle: false };
  }

  private releaseBar(slot: BarSlot): void {
    slot.el.classList.add(this.styles.hidden);
    slot.idle = true;
    this.idleBars.push(slot);
  }

  private setBarState(slot: BarSlot, state: number): void {
    const changed = state ^ slot.state;
    if (changed === 0) return;
    for (const [bit, name] of this.stateClasses) {
      if ((changed & bit) !== 0) {
        slot.el.classList.toggle(name, (state & bit) !== 0);
        this.stats.classWrites++;
      }
    }
    slot.state = state;
  }

  private writeBars(): void {
    const { controller } = this.context;
    const { plan } = this;
    const { layout } = controller;
    const { itemRow } = controller.model;
    const ids = controller.index.table.ids;
    const top = layout.headerHeight;
    const frame = ++this.frame;
    const count = plan.runCount;
    const { runX0, runX1, runY, runFirst, runItems, runKind, runFlags } = plan;

    this.runLabel.fill(-1, 0, count);
    for (let l = 0; l < plan.labelCount; l++) this.runLabel[plan.labelRun[l]] = l;
    const hovering = this.context.controller.store.state.hover !== null;
    this.anyHover = false;

    for (let r = 0; r < count; r++) {
      const first = runFirst[r];
      let slot = this.bars.get(first);
      if (slot === undefined) {
        slot = this.takeBar();
        this.bars.set(first, slot);
      }
      slot.used = frame;
      this.runSlots[r] = slot;

      const x = runX0[r];
      const w = runX1[r] - x;
      const y = runY[r] - top + layout.barInset;
      const items = runItems[r];

      if (slot.first !== first || slot.items !== items) {
        const { el } = slot;
        if (slot.first !== first) el.setAttribute('data-span-id', ids[itemRow[first]]);
        if (items > 1) el.setAttribute('data-count', String(items));
        else if (slot.items > 1) el.removeAttribute('data-count');
        slot.first = first;
        slot.items = items;
      }

      const kind = runKind[r] < this.kindClasses.length ? runKind[r] : 0;
      if (kind !== slot.kind) {
        slot.el.classList.remove(this.kindClasses[slot.kind]);
        slot.el.classList.add(this.kindClasses[kind]);
        slot.kind = kind;
        this.stats.geometryWrites++;
      }
      if (x !== slot.x || y !== slot.y) {
        slot.el.style.transform = `translate(${x}px, ${y}px)`;
        slot.x = x;
        slot.y = y;
        this.stats.geometryWrites++;
      }
      if (w !== slot.w) {
        slot.el.style.width = `${w}px`;
        slot.w = w;
        this.stats.geometryWrites++;
      }

      const l = this.runLabel[r];
      const text = l >= 0 ? plan.labelText[l] : '';
      if (text !== slot.label) {
        slot.el.textContent = text;
        slot.label = text;
        this.stats.geometryWrites++;
      }
      if (l >= 0) {
        const pad = Math.round(plan.labelX[l] - x);
        if (pad !== slot.pad) {
          slot.el.style.paddingLeft = `${pad}px`;
          slot.pad = pad;
          this.stats.geometryWrites++;
        }
      }

      let state = runFlags[r] & PLAN_STATE_MASK;
      if (w < SHARP_BELOW_PX) state |= SHARP;
      if (hovering && this.runHovered(first, items, itemRow)) {
        state |= RunFlag.Hovered;
        this.anyHover = true;
      }
      this.setBarState(slot, state);
    }

    for (const [first, slot] of this.bars) {
      if (slot.used === frame) continue;
      this.bars.delete(first);
      this.releaseBar(slot);
    }
    this.trimBars();
  }

  /**
   * Give idle bar elements back to the document: never more than the frame budget in all, and not
   * far more than the next frames are likely to need, so the DOM stays bounded however the view is
   * zoomed.
   */
  private trimBars(): void {
    const used = this.bars.size;
    const allowed = Math.max(0, Math.min(MAX_BARS - used, Math.max(KEEP_IDLE_BARS, 2 * used)));
    if (this.idleBars.length <= allowed) return;
    const drop = this.idleBars.splice(allowed);
    for (const slot of drop) slot.el.remove();
    this.stats.barElements -= drop.length;
  }

  private runHovered(first: number, items: number, itemRow: Int32Array): boolean {
    const { controller } = this.context;
    for (let i = first; i < first + items; i++) if (controller.isHovered(itemRow[i])) return true;
    return false;
  }

  /** The hover classes of the bars of the last full redraw, without planning the frame again. */
  private applyBarHover(): void {
    const { controller } = this.context;
    const hovering = controller.store.state.hover !== null;
    if (!hovering && !this.anyHover) return;
    const { plan } = this;
    const { itemRow } = controller.model;
    let any = false;
    for (let r = 0; r < plan.runCount; r++) {
      const slot = this.runSlots[r];
      const hovered = hovering && this.runHovered(plan.runFirst[r], plan.runItems[r], itemRow);
      if (hovered) any = true;
      this.setBarState(slot, hovered ? slot.state | RunFlag.Hovered : slot.state & ~RunFlag.Hovered);
    }
    this.anyHover = any;
  }

  // ---------------------------------------------------------------------------
  // Lane headers
  // ---------------------------------------------------------------------------

  private takeHeader(): HeaderSlot {
    const idle = this.idleHeaders.pop();
    if (idle !== undefined) {
      idle.root.classList.remove(this.styles.hidden);
      return idle;
    }
    const chevron = h('span', { class: this.styles.chevron, 'data-part': 'chevron' });
    const name = h('div', { class: this.styles.name });
    const stats = h('div', { class: [this.styles.stats, this.styles.statsHidden] });
    const content = h('div', { class: this.styles.headerContent }, chevron, h('div', { class: this.styles.headerText }, name, stats));
    const gutter = h('div', { class: this.styles.gutter }, content);
    const root = h('div', { class: this.styles.header, role: 'treeitem', 'aria-level': 1, 'data-part': 'lane' }, h('div', { class: this.styles.laneLine }), gutter);
    this.body.append(root);
    return {
      root, gutter, content, chevron, name, stats,
      lane: -1, y: Number.NaN, height: Number.NaN, offset: Number.NaN, mode: -1, tall: false, statsText: '', stamp: -1, hovered: false, used: 0,
    };
  }

  private writeHeaders(): void {
    const { controller } = this.context;
    const { plan } = this;
    const { layout, model } = controller;
    const { stack } = controller.state;
    const frame = this.frame;
    const top = layout.headerHeight;
    const styles = this.styles;

    for (let j = 0; j < plan.headerCount; j++) {
      const lane = plan.headerLane[j];
      let slot = this.headers.get(lane);
      if (slot === undefined) {
        slot = this.takeHeader();
        this.headers.set(lane, slot);
      }
      slot.used = frame;

      const y = plan.headerY[j] - top;
      const height = plan.headerHeight[j];
      if (y !== slot.y) {
        slot.root.style.transform = `translateY(${y}px)`;
        slot.y = y;
      }
      if (height !== slot.height) {
        slot.root.style.height = `${height}px`;
        slot.height = height;
      }
      // not only when the height changes: the row height may have changed under a collapsed lane
      const tall = height >= 2 * layout.rowHeight;
      if (tall !== slot.tall) {
        slot.stats.classList.toggle(styles.statsHidden, !tall);
        slot.tall = tall;
      }

      if (slot.lane !== lane) {
        slot.lane = lane;
        slot.name.textContent = plan.headerName[j];
        slot.name.classList.toggle(styles.namePeer, lane >= model.serviceCount);
        slot.root.setAttribute('data-lane', plan.headerName[j]);
        slot.stamp = -1;
        slot.mode = -1;
        slot.statsText = '';
        // a header of the old trace may have been hovered: the class goes with the flag
        if (slot.hovered) slot.gutter.classList.remove(styles.headerHover);
        slot.hovered = false;
      }
      if (slot.stamp !== this.stamp) {
        slot.root.setAttribute('aria-posinset', String(stack.positionOfLane[lane] + 1));
        slot.root.setAttribute('aria-setsize', String(stack.count));
        slot.stamp = this.stamp;
      }
      const mode = plan.headerMode[j];
      if (mode !== slot.mode) {
        const collapsed = mode === LaneMode.Collapsed;
        slot.chevron.classList.remove(collapsed ? styles.chevronState.expanded : styles.chevronState.collapsed);
        slot.chevron.classList.add(collapsed ? styles.chevronState.collapsed : styles.chevronState.expanded);
        slot.root.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        slot.mode = mode;
      }
      const statsText = plan.headerStats[j];
      if (statsText !== slot.statsText) {
        slot.stats.textContent = statsText;
        slot.statsText = statsText;
      }

      // the name stays visible while the lane's top is scrolled under the ruler, as long as the lane lasts
      const room = Math.max(0, height - (slot.tall ? layout.rowHeight + 14 : layout.rowHeight) - 2);
      const offset = Math.round(Math.min(Math.max(0, -y), room));
      if (offset !== slot.offset) {
        slot.content.style.transform = `translateY(${offset}px)`;
        slot.offset = offset;
      }
    }

    for (const [lane, slot] of this.headers) {
      if (slot.used === frame) continue;
      this.headers.delete(lane);
      slot.root.classList.add(styles.hidden);
      if (slot.hovered) slot.gutter.classList.remove(styles.headerHover);
      slot.hovered = false;
      slot.lane = -1;
      this.idleHeaders.push(slot);
    }
  }

  // ---------------------------------------------------------------------------
  // Summaries
  // ---------------------------------------------------------------------------

  private takeSummary(): SummarySlot {
    const idle = this.idleSummaries.pop();
    if (idle !== undefined) {
      idle.wrap.classList.remove(this.styles.hidden);
      return idle;
    }
    const area = svgElement('path', this.styles.summaryArea);
    const errors = svgElement('path', this.styles.summaryErrors);
    const svg = svgElement('svg');
    svg.classList.add(this.styles.summarySvg);
    svg.setAttribute('aria-hidden', 'true');
    svg.append(area, errors);
    const button = h('div', { class: [this.styles.overflowButton, this.styles.hidden], 'data-part': 'overflow' });
    const wrap = h('div', { class: this.styles.summary, 'data-part': 'summary' }, svg, button);
    this.plot.append(wrap);
    return {
      wrap, svg, area, errors, button,
      lane: -1, kind: -1, y: Number.NaN, height: Number.NaN, width: Number.NaN, hidden: -1, areaPath: '', errorPath: '', buttonHovered: false, used: 0,
    };
  }

  private writeSummaries(): void {
    const { controller } = this.context;
    const { plan } = this;
    const { layout } = controller;
    const frame = this.frame;
    const top = layout.headerHeight;
    const styles = this.styles;

    for (let s = 0; s < plan.summaryCount; s++) {
      const lane = plan.summaryLane[s];
      let slot = this.summaries.get(lane);
      if (slot === undefined) {
        slot = this.takeSummary();
        this.summaries.set(lane, slot);
      }
      slot.used = frame;
      slot.lane = lane;

      const y = plan.summaryY[s] - top;
      if (y !== slot.y) {
        slot.wrap.style.transform = `translateY(${y}px)`;
        slot.y = y;
      }
      const height = plan.summaryH[s];
      if (height !== slot.height || layout.plotWidth !== slot.width) {
        slot.svg.setAttribute('width', String(layout.plotWidth));
        slot.svg.setAttribute('height', String(height));
        slot.height = height;
        slot.width = layout.plotWidth;
      }

      const kind = plan.summaryKind[s];
      if (kind !== slot.kind) {
        const overflow = kind === SummaryKind.Overflow;
        slot.area.classList.toggle(styles.summaryOverflowArea, overflow);
        slot.button.classList.toggle(styles.hidden, !overflow);
        slot.wrap.setAttribute('data-summary', overflow ? 'overflow' : 'collapsed');
        slot.kind = kind;
        slot.hidden = -1;
      }
      if (kind === SummaryKind.Overflow) {
        const hidden = plan.summaryHidden[s];
        if (hidden !== slot.hidden) {
          slot.button.textContent = `+${hidden} ${hidden === 1 ? 'row' : 'rows'}`;
          slot.hidden = hidden;
        }
      }

      const area = plan.summaryPath[s];
      if (area !== slot.areaPath) {
        slot.area.setAttribute('d', area);
        slot.areaPath = area;
      }
      const errors = plan.summaryErrors[s];
      if (errors !== slot.errorPath) {
        slot.errors.setAttribute('d', errors);
        slot.errorPath = errors;
      }
    }

    for (const [lane, slot] of this.summaries) {
      if (slot.used === frame) continue;
      this.summaries.delete(lane);
      slot.wrap.classList.add(styles.hidden);
      if (slot.buttonHovered) slot.button.classList.remove(styles.overflowButtonHover);
      slot.buttonHovered = false;
      slot.lane = -1;
      this.idleSummaries.push(slot);
    }
  }

  // ---------------------------------------------------------------------------
  // Ruler
  // ---------------------------------------------------------------------------

  /** Grid lines and the ruler's ticks. */
  private writeTicks(): void {
    const { layout } = this.context.controller;
    const { plan } = this;

    while (this.ticks.length < plan.tickCount) {
      const grid = h('div', { class: this.styles.gridLine });
      const line = h('div', { class: this.styles.rulerLine });
      const label = h('span', { class: this.styles.rulerLabel });
      this.plot.prepend(grid);
      this.ruler.append(line, label);
      this.ticks.push({ grid, line, label, text: '' });
    }
    for (let i = 0; i < this.ticks.length; i++) {
      const elements = this.ticks[i];
      const visible = i < plan.tickCount;
      elements.grid.classList.toggle(this.styles.hidden, !visible);
      elements.line.classList.toggle(this.styles.hidden, !visible);
      elements.label.classList.toggle(this.styles.hidden, !visible);
      if (!visible) continue;
      const x = Math.round(plan.tickX[i]);
      elements.grid.style.transform = `translateX(${x}px)`;
      elements.line.style.transform = `translateX(${layout.plotLeft + x}px)`;
      elements.label.style.transform = `translateX(${layout.plotLeft + x}px)`;
      if (plan.tickLabel[i] !== elements.text) {
        elements.label.textContent = plan.tickLabel[i];
        elements.text = plan.tickLabel[i];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pointer overlay
  // ---------------------------------------------------------------------------

  /** What the pointer is over, outside the bars (they carry their own hover class): lane header, overflow button and a box. */
  private applyHover(): void {
    const { controller } = this.context;
    const { layout } = controller;
    const hover = controller.state.hover;
    const styles = this.styles;

    for (const slot of this.headers.values()) {
      const hovered = hover !== null && hover.part === HitPart.Header && hover.lane === slot.lane;
      if (hovered !== slot.hovered) {
        slot.gutter.classList.toggle(styles.headerHover, hovered);
        slot.hovered = hovered;
      }
    }
    for (const slot of this.summaries.values()) {
      const hovered = hover !== null && hover.part === HitPart.Overflow && hover.button && hover.lane === slot.lane;
      if (hovered !== slot.buttonHovered) {
        slot.button.classList.toggle(styles.overflowButtonHover, hovered);
        slot.buttonHovered = hovered;
      }
    }

    const box = this.hoverBox;
    const boxed = hover !== null && (hover.part === HitPart.IdleGap || hover.part === HitPart.Summary || (hover.part === HitPart.Overflow && !hover.button));
    if (boxed) {
      const placed = `${hover.x - layout.plotLeft}px, ${hover.y - layout.headerHeight}px, ${hover.w}px, ${hover.h}px`;
      if (placed !== this.hoverPlaced) {
        box.style.transform = `translate(${hover.x - layout.plotLeft}px, ${hover.y - layout.headerHeight}px)`;
        box.style.width = `${hover.w}px`;
        box.style.height = `${hover.h}px`;
        this.hoverPlaced = placed;
      }
    }
    if (boxed === this.hoverShown) return;
    box.classList.toggle(styles.hidden, !boxed);
    this.hoverShown = boxed;
  }
}

/** Create the DOM painter: pooled bar elements, lane headers and summary paths in the host. */
export function createDomPainter(context: PainterContext, styles: DomClasses): LanesPainter {
  return new LanesDomPainter(context, styles);
}
