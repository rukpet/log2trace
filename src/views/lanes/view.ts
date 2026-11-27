/**
 * The lanes view: the DOM half of the lanes, behind the view contract.
 *
 * The headless `LanesController` decides what is shown; this class gives it a surface. It builds the
 * native scroller (`part="plot"`, a transparent element whose spacer gives the lanes their scroll
 * range, so the wheel, touch, keys and scrollbar all work natively while the DOM painter redraws from
 * the scroll position), binds the input kit to it, mounts the pooled DOM painter, and reports hovers
 * to the page through the view context. Nothing here knows about the filter bar, the detail panel or
 * the tabs.
 *
 * What it shares through the store: a click on a bar or a merged run selects its spans, a hover does
 * the same, the filter dims the bars that did not pass (and makes the summaries count matches only),
 * the time window follows other views, and the selection and hover made elsewhere light the bars that
 * hold those spans. What is its own: the camera, the scroll position and how each lane is shown
 * (collapsed, capped, full), kept across tabs with `getState`. Collapsed spans are ignored, as the
 * store documents: hiding spans would leave false idle gaps in the lanes.
 *
 * A screen reader hears the selected span through a live region; the lane headers are the tree items
 * of the painter. Bars are not individually accessible.
 */

import { Slice, formatDuration, touches, type ChangeSet, type SpanId } from '../../core/index.ts';
import * as a11yStyles from '../../kit/a11y.css.ts';
import type { ViewCommand } from '../../kit/commands.ts';
import { h } from '../../kit/dom.ts';
import { bindInput } from '../../kit/input/bind.ts';
import { InputActionKind, Key, type InputAction } from '../../kit/input/types.ts';
import { getFrameScheduler, type FrameScheduler } from '../../kit/scheduler.ts';
import { createTextMeter, measureWithContext, type TextMeter } from '../../kit/text-cache.ts';
import type { TraceView, ViewContext, ViewDefinition } from '../../kit/view.ts';
import { LanesController, type UpdateResult } from './controller.ts';
import { HitPart } from './model/hit.ts';
import { LanesDirty, type Cursor, type HoverInfo, type LanesInput } from './model/interaction.ts';
import { mountDomPainter } from './paint/dom-mount.ts';
import type { LanesPainter, PainterStats } from './paint/dom.ts';
import { readLanesSettings } from './settings.ts';
import * as styles from './view.css.ts';

/** Maps the keys of the input kit to the `KeyboardEvent.key` values the reducer knows. */
const KEY_NAMES: Readonly<Record<Key, string>> = {
  [Key.ArrowUp]: 'ArrowUp',
  [Key.ArrowDown]: 'ArrowDown',
  [Key.ArrowLeft]: 'ArrowLeft',
  [Key.ArrowRight]: 'ArrowRight',
  [Key.Home]: 'Home',
  [Key.End]: 'End',
  [Key.PageUp]: 'PageUp',
  [Key.PageDown]: 'PageDown',
  [Key.Enter]: 'Enter',
  [Key.Space]: ' ',
  [Key.Escape]: 'Escape',
  [Key.Plus]: '+',
  [Key.Minus]: '-',
  [Key.Zero]: '0',
  [Key.I]: 'i',
  [Key.F]: 'f',
  [Key.R]: 'r',
  [Key.E]: 'e',
  [Key.G]: 'g',
  [Key.M]: 'm',
};

/** Changes of these make a hover's box or content stale until the pointer moves again. */
const HOVER_STALE_BITS = LanesDirty.Lanes | LanesDirty.Scroll | LanesDirty.Camera | LanesDirty.Size;

/** What the view keeps while it is mounted. */
interface Mounted {
  readonly ctx: ViewContext;
  readonly controller: LanesController;
  readonly plot: HTMLElement;
  readonly spacer: HTMLElement;
  readonly surface: HTMLElement;
  readonly note: HTMLElement;
  readonly live: HTMLElement;
  readonly meter: TextMeter;
  readonly cleanups: Array<() => void>;
  painter: LanesPainter | null;
  cursor: Cursor;
  hoverKey: string | null;
  liveText: string;
}

/** What the view can be given instead of the page's frame loop and canvas, for tests. */
export interface LanesViewOptions {
  readonly scheduler?: FrameScheduler;
  readonly meter?: TextMeter;
}

/** What identifies the element under the pointer, so the tooltip is rebuilt only when it changes. */
function hoverKeyOf(generation: number, hover: HoverInfo): string {
  switch (hover.part) {
    case HitPart.Bar:
    case HitPart.Run:
      return `${generation}:run:${hover.item}:${hover.count}`;
    case HitPart.Header:
      return `${generation}:header:${hover.lane}`;
    case HitPart.Summary:
      return `${generation}:summary:${hover.lane}:${hover.t.toFixed(3)}`;
    case HitPart.Overflow:
      return `${generation}:overflow:${hover.lane}:${hover.button ? 'button' : hover.t.toFixed(3)}`;
    case HitPart.IdleGap:
      return `${generation}:gap:${hover.lane}:${hover.gapFrom}:${hover.gapTo}`;
    default:
      return `${generation}:${hover.part}`;
  }
}

/** The lanes view. */
export class LanesView implements TraceView {
  private mounted: Mounted | null = null;
  private readonly options: LanesViewOptions;

  constructor(options: LanesViewOptions = {}) {
    this.options = options;
  }

  /** Parts of the view for tests and the performance harness; not a public API. */
  get internals(): { readonly controller: LanesController; readonly painter: LanesPainter | null; readonly plot: HTMLElement } | null {
    const m = this.mounted;
    return m === null ? null : { controller: m.controller, painter: m.painter, plot: m.plot };
  }

  /** What the painter drew, for the performance harness. */
  get painterStats(): PainterStats | null {
    return this.mounted?.painter?.stats ?? null;
  }

  mount(surface: HTMLElement, ctx: ViewContext): void {
    if (this.mounted !== null) return;
    const controller = new LanesController({ store: ctx.store, origin: ctx.origin, settings: readLanesSettings(ctx.options()) });
    const cleanups: Array<() => void> = [];

    const spacer = h('div', { class: styles.spacer });
    const plot = h('div', { class: [styles.plot, styles.cursor.default], part: 'plot', tabindex: 0, role: 'application', 'aria-label': 'Trace lanes' }, spacer);
    const note = h('div', { class: styles.empty, hidden: true }, 'No spans to show.');
    const live = h('div', { class: a11yStyles.visuallyHidden, 'aria-live': 'polite' });
    surface.append(plot);

    this.mounted = { ctx, controller, plot, spacer, surface, note, live, meter: this.createMeter(), cleanups, painter: null, cursor: 'default', hoverKey: null, liveText: '' };

    cleanups.push(bindInput(plot, {
      onAction: (action) => this.onAction(action),
      wheelZoom: () => controller.wheelZoom,
    }));
    const onScroll = (): void => {
      this.run({ type: 'scroll', top: plot.scrollTop });
    };
    plot.addEventListener('scroll', onScroll);
    cleanups.push(() => plot.removeEventListener('scroll', onScroll));

    this.mountPainter();
    surface.append(note, live);
    this.syncSpacer();
    this.syncNote();
    this.announce();
  }

  unmount(): void {
    const m = this.mounted;
    if (m === null) return;
    this.mounted = null;
    for (const cleanup of m.cleanups) cleanup();
    m.painter?.dispose();
    m.plot.remove();
    m.note.remove();
    m.live.remove();
    if (m.controller.state.hover !== null) m.ctx.store.setHover(null, { origin: m.ctx.origin });
    m.ctx.hover(null);
  }

  update(change: ChangeSet): void {
    const m = this.mounted;
    if (m === null) return;
    this.apply(m.controller.update(change));
    if (touches(change, Slice.Data)) this.syncNote();
    if (touches(change, Slice.Selection | Slice.Data)) this.announce();
  }

  optionsChanged(): void {
    const m = this.mounted;
    if (m === null) return;
    this.apply(m.controller.applySettings(readLanesSettings(m.ctx.options())));
  }

  themeChanged(): void {
    const m = this.mounted;
    if (m === null) return;
    m.painter?.refreshTheme();
  }

  commands(): readonly ViewCommand[] {
    return this.mounted?.controller.commands((result) => this.apply(result)) ?? [];
  }

  focus(): void {
    this.mounted?.plot.focus({ preventScroll: true });
  }

  reveal(id: SpanId): void {
    const m = this.mounted;
    if (m === null) return;
    this.apply(m.controller.reveal(id, 'center'));
  }

  getState(): unknown {
    return this.mounted?.controller.getState() ?? null;
  }

  setState(state: unknown): void {
    const m = this.mounted;
    if (m === null) return;
    this.apply(m.controller.setState(state));
  }

  // ---------------------------------------------------------------------------

  /** Text widths are measured with a canvas of our own, which never draws. */
  private createMeter(): TextMeter {
    if (this.options.meter !== undefined) return this.options.meter;
    const context = document.createElement('canvas').getContext('2d');
    if (context === null) throw new Error('the lanes view needs a 2D canvas');
    return createTextMeter({ measure: measureWithContext(context) });
  }

  private mountPainter(): void {
    const m = this.mounted;
    if (m === null) return;
    m.painter = mountDomPainter({
      controller: m.controller,
      host: m.surface,
      meter: m.meter,
      scheduler: this.options.scheduler ?? getFrameScheduler(),
      onSize: (width, height) => this.apply(m.controller.resize(width, height)),
    });
    m.painter.mark(LanesDirty.Lanes | LanesDirty.Scroll | LanesDirty.Camera | LanesDirty.Selection | LanesDirty.Hover | LanesDirty.Theme | LanesDirty.Size);
  }

  /** Run an input through the controller and carry out what it asks for. */
  private run(input: LanesInput): boolean {
    const m = this.mounted;
    if (m === null) return false;
    const result = m.controller.input(input);
    this.apply({ dirty: result.dirty, scrollTo: result.scrollTo });
    if (result.cursor !== m.cursor) {
      m.plot.classList.replace(styles.cursor[m.cursor], styles.cursor[result.cursor]);
      m.cursor = result.cursor;
    }
    return result.handled;
  }

  private onAction(action: InputAction): boolean {
    const m = this.mounted;
    if (m === null) return false;
    switch (action.kind) {
      case InputActionKind.Hover:
        this.run({ type: 'hover', x: action.x, y: action.y });
        return true;
      case InputActionKind.HoverEnd:
        this.run({ type: 'leave' });
        return true;
      case InputActionKind.Click:
        this.run({ type: 'click', x: action.x, y: action.y, additive: action.ctrlKey || action.metaKey || action.shiftKey });
        return true;
      case InputActionKind.DoubleClick:
        this.run({ type: 'doubleClick', x: action.x, y: action.y });
        return true;
      case InputActionKind.Pan:
        if (action.dx !== 0) this.run({ type: 'pan', dx: action.dx });
        if (action.dy !== 0) m.plot.scrollTop -= action.dy;
        return true;
      case InputActionKind.Zoom:
        this.run({ type: 'pinch', x: action.x, scale: 1 / action.factor });
        return true;
      case InputActionKind.KeyDown:
        if (action.key === Key.Escape) {
          if (m.ctx.store.state.selection.ids.size === 0) return false;
          m.ctx.store.setSelection([], { origin: m.ctx.origin });
          return true;
        }
        return this.run({ type: 'key', key: KEY_NAMES[action.key], shift: action.shiftKey, ctrl: false, alt: false });
      default:
        return true;
    }
  }

  /** Carry out what the controller asked for after a change of the store, an input or a resize. */
  private apply(result: UpdateResult): void {
    const m = this.mounted;
    if (m === null) return;
    const { dirty } = result;
    if (dirty === 0 && !result.scrollTo) return;

    if ((dirty & (LanesDirty.Lanes | LanesDirty.Size)) !== 0) this.syncSpacer();
    if (result.scrollTo && m.plot.scrollTop !== m.controller.state.scrollTop) m.plot.scrollTop = m.controller.state.scrollTop;
    if ((dirty & (LanesDirty.Camera | LanesDirty.Lanes)) !== 0) m.ctx.refreshCommands();

    m.painter?.mark(dirty);
    this.reportHover(dirty);
  }

  /** The height of the spacer gives the scroller exactly the scroll range of the lanes. */
  private syncSpacer(): void {
    const m = this.mounted;
    if (m === null) return;
    const { layout, state } = m.controller;
    m.spacer.style.height = `${layout.headerHeight + state.stack.contentHeight}px`;
  }

  private syncNote(): void {
    const m = this.mounted;
    if (m === null) return;
    m.note.hidden = m.controller.index.table.length > 0;
  }

  /** A screen reader hears what was selected. */
  private announce(): void {
    const m = this.mounted;
    if (m === null) return;
    const { selection } = m.ctx.store.state;
    const { index } = m.controller;
    const span = selection.primary === null ? undefined : index.spans.get(selection.primary);
    let text = '';
    if (span !== undefined) {
      const { table } = index;
      const row = span.idx;
      text = `${table.names[table.nameId[row]]}, ${table.services[table.svc[row]]}, ${formatDuration(table.end[row] - table.start[row])}`;
      if (selection.ids.size > 1) text += `, ${selection.ids.size} spans selected`;
    }
    if (text === m.liveText) return;
    m.liveText = text;
    m.live.textContent = text;
  }

  /** Tell the page what the pointer rests on, or that it rests on nothing. */
  private reportHover(dirty: number): void {
    const m = this.mounted;
    if (m === null) return;
    const hover = m.controller.state.hover;
    if (hover === null || (dirty & HOVER_STALE_BITS) !== 0) {
      if (m.hoverKey !== null) {
        m.hoverKey = null;
        m.ctx.hover(null);
      }
      return;
    }
    const key = hoverKeyOf(m.ctx.store.state.data.generation, hover);
    if (key === m.hoverKey) return;
    m.hoverKey = key;
    const { controller } = m;
    m.ctx.hover({
      key,
      anchor: { x: hover.x, y: hover.y, w: hover.w, h: hover.h },
      bounds: { width: controller.layout.width, height: controller.layout.height },
      info: () => controller.describeHit(hover),
    });
  }
}

/** The lanes view, as the element lists it. */
export const lanesDefinition: ViewDefinition = {
  id: 'lanes',
  label: 'Lanes',
  capabilities: { legend: true },
  create: () => new LanesView(),
};
