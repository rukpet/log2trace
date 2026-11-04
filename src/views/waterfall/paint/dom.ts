/**
 * Waterfall painter for the DOM.
 *
 * The same frame plan as the Canvas painter, turned into elements. The rows in view live in a
 * small pool of row elements (a row `r` always uses slot `r mod P`, so scrolling only moves the
 * rows that are still in view and rewrites the ones entering), which keeps the DOM at a few
 * hundred nodes however many spans the trace has. What a row shows is cached per slot and written
 * only when it changes: scrolling writes one transform per row, zooming writes the bar geometry,
 * hovering and selecting toggle classes on at most two rows.
 *
 * Bar positions come from the plan, clipped in JS to just outside the plot: CSS lengths in the
 * hundreds of millions of pixels (a bar at deep zoom) would saturate the layout engine's limit and
 * make the bar disappear. Rows are `treeitem`s, so a screen reader and find-in-page see them
 * without a mirror.
 *
 * Input is not handled here: the element's native scroller sits above the layer and its events go
 * through the controller's geometric hit test, exactly as for the canvas.
 */

import { timeToPx } from '../../../kit/geometry/camera1d.ts';
import { niceTicks } from '../../../kit/geometry/ticks.ts';
import { h } from '../../../kit/dom.ts';
import { Dirty, type FrameHandle } from '../../../kit/scheduler.ts';
import type { ResolvedTheme } from '../../../kit/theme/theme.ts';
import { clearOnFontLoad } from '../../../kit/canvas/text-cache.ts';
import { HitPart } from '../model/hit.ts';
import { chevronX } from '../model/layout.ts';
import { FramePlan, LabelMode, RowFlag } from '../model/plan.ts';
import { Chevron } from '../model/rows.ts';
import type * as DomStyles from './dom.css.ts';
import { toSurfaceDirty, type PainterContext, type PainterStats, type WaterfallPainter } from './painter.ts';

/** Event markers a row has elements for; the plan may carry more, and the rest are dropped. */
export const MAX_DOM_MARKERS = 16;

/** Extra slots beyond the rows in view, so a row that just left is not rewritten at once. */
const SPARE_SLOTS = 2;

const SCENE_BITS = Dirty.Size | Dirty.Theme | Dirty.Rows | Dirty.Scroll | Dirty.Camera;
const OVERLAY_BITS = SCENE_BITS | Dirty.Selection | Dirty.Hover;

/** The class names of `dom.css.ts`; passed in, so this module does not import the stylesheet and runs under `node:test`. */
export type DomClasses = typeof DomStyles;

/** Bits of a slot's cached state. */
enum State {
  Hover = 1,
  Selected = 2,
  Context = 4,
  Error = 8,
}

/** One row element and what was last written to it. */
interface Slot {
  readonly row: HTMLElement;
  readonly gutter: HTMLElement;
  readonly chevron: HTMLElement;
  readonly name: HTMLElement;
  readonly service: HTMLElement;
  readonly plotCell: HTMLElement;
  readonly bar: HTMLElement;
  readonly duration: HTMLElement;
  readonly markers: HTMLElement[];

  span: number;
  contentStamp: number;
  barStamp: number;
  y: number;
  state: number;
  kind: number;
  chevronState: number;
  barVisible: boolean;
  barX: number;
  barW: number;
  shownMarkers: number;
  durationMode: number;
  durationX: number;
  durationText: string;
  usedFrame: number;
  hidden: boolean;
}

interface TickElements {
  readonly grid: HTMLElement;
  readonly line: HTMLElement;
  readonly label: HTMLElement;
}

function createSlot(styles: DomClasses, kindClasses: readonly string[]): Slot {
  const chevron = h('span', { class: [styles.chevron, styles.chevronState.none] });
  const name = h('span', { class: styles.name });
  const service = h('span', { class: styles.service });
  const gutter = h('div', { class: styles.gutter }, chevron, name, service);
  const bar = h('div', { class: [styles.bar, kindClasses[0]] });
  const duration = h('span', { class: styles.duration });
  const markers: HTMLElement[] = [];
  for (let i = 0; i < MAX_DOM_MARKERS; i++) markers.push(h('span', { class: [styles.marker, styles.hidden] }));
  const plotCell = h('div', { class: styles.plotCell }, bar, markers, duration);
  const row = h('div', { class: styles.row, role: 'treeitem' }, gutter, plotCell);
  return {
    row, gutter, chevron, name, service, plotCell, bar, duration, markers,
    span: -1, contentStamp: -1, barStamp: -1, y: Number.NaN, state: -1, kind: -1, chevronState: -1,
    barVisible: true, barX: Number.NaN, barW: Number.NaN, shownMarkers: 0, durationMode: -1, durationX: Number.NaN,
    durationText: '', usedFrame: -1, hidden: false,
  };
}

/** The custom property name inside a `var(--name)` reference from `createVar()`. */
function variableName(reference: string): string {
  const match = /^var\((--[^),\s]+)/.exec(reference);
  if (match === null) throw new Error(`not a CSS variable reference: ${reference}`);
  return match[1];
}

/** The DOM painter. Create it with {@link mountDomPainter}. */
class WaterfallDomPainter implements WaterfallPainter {
  readonly kind = 'dom' as const;
  readonly stats: PainterStats = { scenes: 0, overlays: 0, rows: 0 };

  private readonly context: PainterContext;
  private readonly styles: DomClasses;
  private readonly kindClasses: readonly string[];
  private readonly chevronClasses: readonly string[];
  private readonly layer: HTMLElement;
  private readonly ruler: HTMLElement;
  private readonly body: HTMLElement;
  private readonly divider: HTMLElement;
  private readonly hoverBox: HTMLElement;
  private readonly plan = new FramePlan();
  private readonly handle: FrameHandle;
  private readonly observer: ResizeObserver;
  private readonly stopFonts: () => void;
  private readonly slots: Slot[] = [];
  private readonly ticks: TickElements[] = [];
  private labelFont = '';
  private contentStamp = 0;
  private cameraStamp = 0;
  private frame = 0;
  private width = 0;
  private height = 0;

  constructor(context: PainterContext, styles: DomClasses) {
    this.context = context;
    this.styles = styles;
    this.kindClasses = [styles.kind.unspecified, styles.kind.internal, styles.kind.server, styles.kind.client, styles.kind.producer, styles.kind.consumer];
    this.chevronClasses = [styles.chevronState.none, styles.chevronState.expanded, styles.chevronState.collapsed];
    this.ruler = h('div', { class: this.styles.ruler });
    this.divider = h('div', { class: this.styles.divider });
    this.hoverBox = h('div', { class: [this.styles.eventHover, this.styles.hidden] });
    this.body = h('div', { class: this.styles.body, role: 'tree', 'aria-label': 'Spans' }, this.hoverBox);
    this.layer = h('div', { class: this.styles.layer }, this.body, this.ruler, this.divider);
    context.host.prepend(this.layer);
    this.setFont(context.theme);

    this.handle = context.scheduler.register({ paint: (dirty) => this.paint(dirty) });
    this.observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      this.width = entry.contentRect.width;
      this.height = entry.contentRect.height;
      this.context.onSize(this.width, this.height);
      this.handle.mark(Dirty.Size);
    });
    this.observer.observe(context.host);
    this.stopFonts = clearOnFontLoad(context.meter, { onCleared: () => this.handle.mark(Dirty.Theme) });
    this.handle.mark(Dirty.All);
  }

  mark(dirty: number): void {
    this.handle.mark(toSurfaceDirty(dirty));
  }

  setTheme(theme: ResolvedTheme): void {
    this.context.meter.clear();
    this.setFont(theme);
    this.handle.mark(Dirty.Theme);
  }

  dispose(): void {
    this.observer.disconnect();
    this.stopFonts();
    this.handle.dispose();
    this.layer.remove();
  }

  private setFont(theme: ResolvedTheme): void {
    this.labelFont = `11px ${theme.fonts.sans}`;
  }

  // ---------------------------------------------------------------------------

  private paint(dirty: number): number | void {
    const { controller } = this.context;
    const layout = controller.layout;
    if (layout.width === 0 || layout.height === 0) return dirty;

    if ((dirty & Dirty.Size) !== 0) {
      this.applyLayout();
    }
    if ((dirty & (Dirty.Size | Dirty.Theme | Dirty.Rows)) !== 0) {
      this.contentStamp++;
      this.cameraStamp++;
    }
    if ((dirty & Dirty.Camera) !== 0) this.cameraStamp++;

    if ((dirty & SCENE_BITS) !== 0) {
      if ((dirty & Dirty.Theme) !== 0) this.context.meter.clear();
      controller.buildPlan(this.plan, (text) => this.context.meter.measure(text, this.labelFont));
      this.writeRows();
      if ((dirty & (Dirty.Size | Dirty.Theme | Dirty.Camera | Dirty.Rows)) !== 0) this.writeTicks();
      this.stats.scenes++;
      this.stats.rows = this.plan.count;
    }
    if ((dirty & OVERLAY_BITS) !== 0) {
      this.applyStates();
      this.stats.overlays++;
    }
  }

  /** Geometry that depends only on the layout: container sizes, and what each slot needs. */
  private applyLayout(): void {
    const { layout } = this.context.controller;
    this.ruler.style.height = `${layout.headerHeight}px`;
    this.body.style.top = `${layout.headerHeight}px`;
    this.divider.style.transform = `translateX(${layout.plotLeft - 1}px)`;
    const set = (variable: string, value: number): void => this.layer.style.setProperty(variableName(variable), `${value}px`);
    set(this.styles.rowHeightVar, layout.rowHeight);
    set(this.styles.gutterWidthVar, layout.gutterWidth);
    set(this.styles.plotLeftVar, layout.plotLeft);
    set(this.styles.plotWidthVar, layout.plotWidth);
    set(this.styles.barInsetVar, layout.barInset);
    set(this.styles.barHeightVar, layout.barHeight);
  }

  private ensureSlots(count: number): void {
    const wanted = count + SPARE_SLOTS;
    if (this.slots.length >= wanted) return;
    // The row-to-slot mapping depends on the number of slots, so growing rewrites everything.
    while (this.slots.length < wanted) {
      const slot = createSlot(this.styles, this.kindClasses);
      this.slots.push(slot);
      this.body.append(slot.row);
    }
    for (const slot of this.slots) slot.span = -1;
    this.contentStamp++;
  }

  private writeRows(): void {
    const { controller } = this.context;
    const { plan } = this;
    const layout = controller.layout;
    this.ensureSlots(plan.count);
    const frame = ++this.frame;
    const poolSize = this.slots.length;

    for (let j = 0; j < plan.count; j++) {
      const row = plan.firstRow + j;
      const slot = this.slots[row % poolSize];
      slot.usedFrame = frame;
      const span = plan.idx[j];
      const changed = slot.span !== span || slot.contentStamp !== this.contentStamp;

      if (slot.hidden) {
        slot.row.style.display = '';
        slot.hidden = false;
      }

      const y = plan.y[j] - layout.headerHeight;
      if (y !== slot.y) {
        slot.row.style.transform = `translateY(${y}px)`;
        slot.y = y;
      }

      const chevron = plan.chevron[j];
      if (changed || chevron !== slot.chevronState) this.writeGutter(slot, span, row, chevron);
      if (changed || slot.barStamp !== this.cameraStamp) this.writeBar(slot, j);
      slot.span = span;
      slot.contentStamp = this.contentStamp;
      slot.barStamp = this.cameraStamp;
    }

    for (const slot of this.slots) {
      if (slot.usedFrame !== frame && !slot.hidden) {
        slot.row.style.display = 'none';
        slot.hidden = true;
        slot.span = -1;
      }
    }
  }

  private writeGutter(slot: Slot, span: number, row: number, chevron: number): void {
    const { controller } = this.context;
    const { table } = controller.index;
    const depth = table.depth[span];
    slot.gutter.style.paddingLeft = `${chevronX(controller.layout, depth)}px`;
    slot.name.textContent = table.names[table.nameId[span]];
    slot.service.textContent = table.services[table.svc[span]];
    if (chevron !== slot.chevronState) {
      slot.chevron.className = `${this.styles.chevron} ${this.chevronClasses[chevron]}`;
      slot.chevronState = chevron;
    }
    const { row: element } = slot;
    element.setAttribute('aria-level', String(depth + 1));
    element.setAttribute('aria-posinset', String(row + 1));
    element.setAttribute('aria-setsize', String(controller.projection.count));
    if (chevron === Chevron.None) element.removeAttribute('aria-expanded');
    else element.setAttribute('aria-expanded', chevron === Chevron.Expanded ? 'true' : 'false');
    slot.state = -1;
  }

  private writeBar(slot: Slot, j: number): void {
    const { plan } = this;
    const flags = plan.flags[j];

    const kind = plan.kind[j] < this.kindClasses.length ? plan.kind[j] : 0;
    if (kind !== slot.kind) {
      slot.bar.className = `${this.styles.bar} ${this.kindClasses[kind]}`;
      slot.kind = kind;
      slot.state = -1;
    }

    const visible = (flags & RowFlag.BarVisible) !== 0;
    if (visible !== slot.barVisible) {
      slot.bar.classList.toggle(this.styles.hidden, !visible);
      slot.barVisible = visible;
    }
    if (!visible) {
      this.hideMarkers(slot, 0);
      this.setDuration(slot, LabelMode.Hidden, 0, '');
      return;
    }

    const x = plan.barX0[j];
    const w = plan.barX1[j] - x;
    if (x !== slot.barX) {
      slot.bar.style.transform = `translateX(${x}px)`;
      slot.barX = x;
    }
    if (w !== slot.barW) {
      slot.bar.style.width = `${w}px`;
      slot.barW = w;
    }

    const first = plan.evOff[j];
    const count = Math.min(plan.evOff[j + 1] - first, MAX_DOM_MARKERS);
    for (let m = 0; m < count; m++) {
      const marker = slot.markers[m];
      marker.style.transform = `translateX(${plan.evX[first + m] - 1}px)`;
      if (m >= slot.shownMarkers) marker.classList.remove(this.styles.hidden);
    }
    this.hideMarkers(slot, count);

    this.setDuration(slot, plan.labelMode[j], plan.labelX[j], plan.durationText[j]);
  }

  private hideMarkers(slot: Slot, keep: number): void {
    for (let m = keep; m < slot.shownMarkers; m++) slot.markers[m].classList.add(this.styles.hidden);
    slot.shownMarkers = keep;
  }

  private setDuration(slot: Slot, mode: number, x: number, text: string): void {
    const element = slot.duration;
    if (mode === LabelMode.Hidden) {
      if (slot.durationMode !== LabelMode.Hidden) element.classList.add(this.styles.hidden);
      slot.durationMode = LabelMode.Hidden;
      return;
    }
    if (slot.durationMode !== mode) {
      element.className = `${this.styles.duration} ${mode === LabelMode.Inside ? this.styles.durationInside : this.styles.durationOutside}`;
      slot.durationMode = mode;
    }
    if (text !== slot.durationText) {
      element.textContent = text;
      slot.durationText = text;
    }
    if (x !== slot.durationX) {
      element.style.transform = `translateX(${x}px)`;
      slot.durationX = x;
    }
  }

  /** Grid lines and the ruler's ticks. */
  private writeTicks(): void {
    const { controller } = this.context;
    const { layout } = controller;
    const camera = controller.state.camera;
    const ticks = layout.plotWidth > 0 ? niceTicks(camera.t0, camera.t1, layout.plotWidth).ticks : [];

    while (this.ticks.length < ticks.length) {
      const grid = h('div', { class: this.styles.gridLine });
      const line = h('div', { class: this.styles.rulerLine });
      const label = h('span', { class: this.styles.rulerLabel });
      this.body.prepend(grid);
      this.ruler.append(line, label);
      this.ticks.push({ grid, line, label });
    }
    for (let i = 0; i < this.ticks.length; i++) {
      const elements = this.ticks[i];
      const visible = i < ticks.length;
      elements.grid.classList.toggle(this.styles.hidden, !visible);
      elements.line.classList.toggle(this.styles.hidden, !visible);
      elements.label.classList.toggle(this.styles.hidden, !visible);
      if (!visible) continue;
      const x = Math.round(layout.plotLeft + timeToPx(camera, ticks[i].value));
      elements.grid.style.transform = `translateX(${x}px)`;
      elements.line.style.transform = `translateX(${x}px)`;
      elements.label.style.transform = `translateX(${x}px)`;
      elements.label.textContent = ticks[i].label;
    }
  }

  /** Hover, selection, context and error as classes, written only where they changed. */
  private applyStates(): void {
    const { controller } = this.context;
    const { plan } = this;
    const poolSize = this.slots.length;
    for (let j = 0; j < plan.count; j++) {
      const slot = this.slots[(plan.firstRow + j) % poolSize];
      const span = plan.idx[j];
      const flags = plan.flags[j];
      let state = 0;
      if (controller.isHovered(span)) state |= State.Hover;
      if (controller.isSelected(span)) state |= State.Selected;
      if ((flags & RowFlag.Context) !== 0) state |= State.Context;
      if ((flags & RowFlag.Error) !== 0) state |= State.Error;
      if (state === slot.state) continue;

      const { row, bar, name } = slot;
      row.classList.toggle(this.styles.rowHover, (state & State.Hover) !== 0);
      row.classList.toggle(this.styles.rowSelected, (state & State.Selected) !== 0);
      row.classList.toggle(this.styles.rowContext, (state & State.Context) !== 0);
      bar.classList.toggle(this.styles.barSelected, (state & State.Selected) !== 0);
      bar.classList.toggle(this.styles.barError, (state & State.Error) !== 0);
      name.classList.toggle(this.styles.nameError, (state & State.Error) !== 0);
      row.setAttribute('aria-selected', (state & State.Selected) !== 0 ? 'true' : 'false');
      slot.state = state;
    }

    const hover = controller.state.hover;
    const box = this.hoverBox;
    if (hover !== null && hover.part === HitPart.Event) {
      box.classList.remove(this.styles.hidden);
      box.style.transform = `translate(${hover.x}px, ${hover.y - controller.layout.headerHeight}px)`;
      box.style.width = `${hover.w}px`;
      box.style.height = `${hover.h}px`;
    } else {
      box.classList.add(this.styles.hidden);
    }
  }
}

/** Create the DOM painter: a layer of recycled row elements in the host. */
export function createDomPainter(context: PainterContext, styles: DomClasses): WaterfallPainter {
  return new WaterfallDomPainter(context, styles);
}
