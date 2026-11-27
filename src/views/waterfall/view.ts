/**
 * The waterfall as a view: the DOM half of the waterfall, behind the view contract.
 *
 * The headless `WaterfallController` decides what is shown; this class gives it a surface. It
 * builds the native scroller (`part="plot"`, a transparent element whose spacer gives the rows
 * their scroll range, so the wheel, touch, keys and scrollbar all work natively while the DOM
 * painter redraws from the scroll position), binds the input kit to it, mounts the virtualized
 * DOM painter, and reports hovers to the page through the view context. Nothing here knows about
 * the filter bar, the detail panel or the tabs.
 */

import { Slice, touches, type ChangeSet, type SpanId } from '../../core/index.ts';
import { describeSpan } from '../../core/index.ts';
import { createTextMeter, measureWithContext, type TextMeter } from '../../kit/text-cache.ts';
import type { ViewCommand } from '../../kit/commands.ts';
import { h } from '../../kit/dom.ts';
import { bindInput } from '../../kit/input/bind.ts';
import { InputActionKind, Key, type InputAction } from '../../kit/input/types.ts';
import { getFrameScheduler } from '../../kit/scheduler.ts';
import type { TraceView, ViewContext, ViewDefinition } from '../../kit/view.ts';
import { WaterfallController, type UpdateResult } from './controller.ts';
import { DEFAULT_METRICS, metricsFromSpanSizes, type WaterfallMetrics } from './model/layout.ts';
import { WaterfallDirty, type Cursor, type WaterfallInput } from './model/interaction.ts';
import { mountDomPainter } from './paint/dom-mount.ts';
import type { PainterStats, WaterfallPainter } from './paint/dom.ts';
import { readWaterfallSettings, type WaterfallSettings } from './settings.ts';
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

/** What the view keeps while it is mounted. */
interface Mounted {
  readonly ctx: ViewContext;
  readonly controller: WaterfallController;
  readonly plot: HTMLElement;
  readonly spacer: HTMLElement;
  readonly surface: HTMLElement;
  readonly meter: TextMeter;
  readonly cleanups: Array<() => void>;
  painter: WaterfallPainter | null;
  cursor: Cursor;
  hoverKey: string | null;
}

/** What is kept when the view is hidden: where the camera and the scroll position are. */
interface SavedState {
  readonly t0: number;
  readonly t1: number;
  readonly scrollTop: number;
}

function isSavedState(value: unknown): value is SavedState {
  if (typeof value !== 'object' || value === null) return false;
  const { t0, t1, scrollTop } = value as Partial<SavedState>;
  return typeof t0 === 'number' && typeof t1 === 'number' && typeof scrollTop === 'number';
}

/** The waterfall view. */
export class WaterfallView implements TraceView {
  private mounted: Mounted | null = null;

  /** Parts of the view for tests and the performance harness; not a public API. */
  get internals(): { readonly controller: WaterfallController; readonly painter: WaterfallPainter | null; readonly plot: HTMLElement } | null {
    const m = this.mounted;
    return m === null ? null : { controller: m.controller, painter: m.painter, plot: m.plot };
  }

  /** What the painter drew, for the performance harness. */
  get painterStats(): PainterStats | null {
    return this.mounted?.painter?.stats ?? null;
  }

  mount(surface: HTMLElement, ctx: ViewContext): void {
    if (this.mounted !== null) return;
    const controller = new WaterfallController({ store: ctx.store, origin: ctx.origin, wheelZoom: readWaterfallSettings(ctx.options()).wheelZoom });
    const cleanups: Array<() => void> = [];

    const spacer = h('div', { class: styles.spacer });
    const plot = h('div', { class: [styles.plot, styles.cursor.default], part: 'plot', tabindex: 0, role: 'application', 'aria-label': 'Trace waterfall' }, spacer);
    surface.append(plot);

    const measureContext = document.createElement('canvas').getContext('2d');
    if (measureContext === null) throw new Error('the waterfall needs a 2D canvas');
    const meter = createTextMeter({ measure: measureWithContext(measureContext) });

    this.mounted = { ctx, controller, plot, spacer, surface, meter, cleanups, painter: null, cursor: 'default', hoverKey: null };

    cleanups.push(bindInput(plot, {
      onAction: (action) => this.onAction(action),
      wheelZoom: () => controller.wheelZoom,
    }));
    const onScroll = (): void => {
      this.run({ type: 'scroll', top: plot.scrollTop });
    };
    plot.addEventListener('scroll', onScroll);
    cleanups.push(() => plot.removeEventListener('scroll', onScroll));

    this.applyMetrics();
    this.mountPainter();
    this.syncSpacer();
  }

  unmount(): void {
    const m = this.mounted;
    if (m === null) return;
    this.mounted = null;
    for (const cleanup of m.cleanups) cleanup();
    m.painter?.dispose();
    m.plot.remove();
    m.ctx.hover(null);
  }

  update(change: ChangeSet): void {
    const m = this.mounted;
    if (m === null) return;
    this.apply(m.controller.update(change));
    if (touches(change, Slice.Data)) this.syncSpacer();
  }

  optionsChanged(): void {
    const m = this.mounted;
    if (m === null) return;
    m.controller.wheelZoom = this.settings().wheelZoom;
    this.applyMetrics();
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
    const span = m?.controller.index.spans.get(id);
    if (span === undefined) return;
    this.run({ type: 'reveal', span: span.idx, align: 'center' });
  }

  getState(): unknown {
    return this.mounted?.controller.getState() ?? null;
  }

  setState(state: unknown): void {
    const m = this.mounted;
    if (m === null || !isSavedState(state)) return;
    this.apply(m.controller.setState(state));
  }

  // ---------------------------------------------------------------------------

  /** The waterfall's own settings, read from the options of the element as they are now. */
  private settings(): WaterfallSettings {
    const m = this.mounted;
    return m === null ? readWaterfallSettings({ config: {}, attribute: () => null }) : readWaterfallSettings(m.ctx.options());
  }

  private applyMetrics(): void {
    const m = this.mounted;
    if (m === null) return;
    const settings = this.settings();
    const metrics: Partial<WaterfallMetrics> = {
      ...metricsFromSpanSizes(settings.spanHeight ?? Number.NaN, settings.spanPadding ?? Number.NaN),
      gutterWidth: settings.gutterWidth ?? DEFAULT_METRICS.gutterWidth,
    };
    this.apply(m.controller.setMetrics(metrics));
  }

  private mountPainter(): void {
    const m = this.mounted;
    if (m === null) return;
    m.painter = mountDomPainter({
      controller: m.controller,
      host: m.surface,
      meter: m.meter,
      scheduler: getFrameScheduler(),
      onSize: (width, height) => this.apply(m.controller.resize(width, height)),
    });
    m.painter.mark(WaterfallDirty.Rows | WaterfallDirty.Scroll | WaterfallDirty.Camera | WaterfallDirty.Selection | WaterfallDirty.Hover | WaterfallDirty.Theme | WaterfallDirty.Size);
  }

  /** Run an input through the controller and carry out what it asks for. */
  private run(input: WaterfallInput): boolean {
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

    if ((dirty & (WaterfallDirty.Rows | WaterfallDirty.Size)) !== 0) this.syncSpacer();
    if (result.scrollTo && m.plot.scrollTop !== m.controller.state.scrollTop) m.plot.scrollTop = m.controller.state.scrollTop;
    if ((dirty & (WaterfallDirty.Camera | WaterfallDirty.Rows)) !== 0) m.ctx.refreshCommands();

    m.painter?.mark(dirty);
    this.reportHover(dirty);
  }

  /** The height of the spacer gives the scroller exactly the scroll range of the rows. */
  private syncSpacer(): void {
    const m = this.mounted;
    if (m === null) return;
    const { layout, projection } = m.controller;
    m.spacer.style.height = `${layout.headerHeight + projection.count * layout.rowHeight}px`;
  }

  /** Tell the page what the pointer rests on, or that it rests on nothing. */
  private reportHover(dirty: number): void {
    const m = this.mounted;
    if (m === null) return;
    const hover = m.controller.state.hover;
    if (hover === null || (dirty & (WaterfallDirty.Camera | WaterfallDirty.Scroll | WaterfallDirty.Rows)) !== 0) {
      if (m.hoverKey !== null) {
        m.hoverKey = null;
        m.ctx.hover(null);
      }
      return;
    }
    const { index, layout } = m.controller;
    const id = index.table.ids[hover.span];
    const key = `${id}:${hover.event}`;
    if (key === m.hoverKey) return;
    m.hoverKey = key;
    m.ctx.hover({
      key,
      anchor: { x: hover.x, y: hover.y, w: hover.w, h: hover.h },
      bounds: { width: layout.width, height: layout.height },
      info: () => describeSpan(index, id, 'brief'),
    });
  }
}

/** The waterfall, as the element lists it. */
export const waterfallDefinition: ViewDefinition = {
  id: 'waterfall',
  label: 'Waterfall',
  capabilities: { legend: true },
  create: () => new WaterfallView(),
};
