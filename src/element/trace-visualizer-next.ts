/**
 * The `<trace-visualizer-next>` element: the 2.0 trace view.
 *
 * It joins the pieces: the shared store (data, selection, collapse), the waterfall controller
 * and its Canvas painter, the input binding on the native scroller, the frame scheduler, the theme
 * probe and the shell (toolbar, tooltip, detail panel). It holds no trace logic of its own.
 *
 * DOM, from the back: the stage holds two canvases (the surface adds them) and the scroller
 * (`part="plot"`), a transparent native scroller whose spacer gives the rows their scroll range,
 * so the wheel, touch, keyboard and scrollbar all work natively while the canvases are redrawn
 * from the scroll position. The tooltip and a visually hidden accessibility tree sit above.
 *
 * Data comes from `traceData`, `logData` or `data-url` (a JSON file of OTel trace data).
 * Attributes: `theme` (`light`, `dark`, default follows the page), `wheel-zoom`, `span-height`,
 * `span-padding`, `gutter-width`, `renderer` (`canvas`; the DOM painter arrives later).
 */

import componentCss from 'virtual:component-css';
import {
  Slice,
  buildSpanIndex,
  createTraceStore,
  describeSpan,
  touches,
  transformLogs,
  type ChangeSet,
  type SpanId,
  type TraceData,
  type TraceStore,
  type LogEntry,
  type TransformConfig,
} from '../core.ts';
import { measure } from '../core/instrumentation.ts';
import { h } from '../kit/dom.ts';
import { createCanvasSurface, type CanvasSurface } from '../kit/canvas/surface.ts';
import { clearOnFontLoad, createTextMeter, measureWithContext, type TextMeter } from '../kit/canvas/text-cache.ts';
import { bindInput } from '../kit/input/bind.ts';
import { InputActionKind, Key, type InputAction } from '../kit/input/types.ts';
import { Dirty, getFrameScheduler, type FrameHandle } from '../kit/scheduler.ts';
import { ThemeProbe } from '../kit/theme/theme.ts';
import * as probeStyles from '../kit/theme/probe.css.ts';
import { metricsFromSpanSizes, type WaterfallMetrics } from '../views/waterfall/model/layout.ts';
import { WaterfallController, type UpdateResult } from '../views/waterfall/controller.ts';
import { WaterfallDirty, type Cursor, type WaterfallInput } from '../views/waterfall/model/interaction.ts';
import { WaterfallCanvasPainter, toSurfaceDirty } from '../views/waterfall/paint/canvas.ts';
import { DetailPanel } from '../shell/detail.ts';
import { createToolbar, type Toolbar } from '../shell/toolbar.ts';
import { Tooltip } from '../shell/tooltip.ts';
import * as styles from './element.css.ts';

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(componentCss);

/** Raw logs and how to read them, as the `logData` setter takes them. */
export interface LogDataInput {
  readonly logs: LogEntry[];
  readonly config: TransformConfig;
}

let instances = 0;

/** Maps the keys of the input kit to the `KeyboardEvent.key` values the view's reducer knows. */
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
};

/** Everything that exists only while the element is in a document. */
interface Mounted {
  readonly surface: CanvasSurface;
  readonly painter: WaterfallCanvasPainter;
  readonly probe: ThemeProbe;
  readonly meter: TextMeter;
  readonly a11y: FrameHandle;
  readonly cleanups: Array<() => void>;
}

/** Custom element backing the `<trace-visualizer-next>` tag. */
export class TraceVisualizerNextElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['data-url', 'theme', 'wheel-zoom', 'span-height', 'span-padding', 'gutter-width', 'renderer'];
  }

  private readonly store: TraceStore;
  private readonly controller: WaterfallController;
  private readonly shadow: ShadowRoot;
  private readonly plot: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly message: HTMLElement;
  private readonly a11yRoot: HTMLElement;
  private readonly tooltip = new Tooltip();
  private readonly detail: DetailPanel;
  private readonly toolbar: Toolbar;
  private mounted: Mounted | null = null;
  private a11yKey = '';
  private cursorName: Cursor = 'default';
  private loadToken = 0;

  constructor() {
    super();
    const scheduler = getFrameScheduler();
    this.store = createTraceStore({ schedule: scheduler.schedule });
    this.controller = new WaterfallController({ store: this.store, origin: `waterfall-${++instances}` });

    this.shadow = this.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = [styleSheet];

    this.spacer = h('div', { class: styles.spacer });
    this.plot = h('div', { class: [styles.plot, styles.cursor.default], part: 'plot', tabindex: 0, role: 'application', 'aria-label': 'Trace waterfall' }, this.spacer);
    this.message = h('div', { class: styles.message, hidden: true });
    this.a11yRoot = h('div', { class: styles.visuallyHidden });
    this.stage = h('div', { class: styles.stage }, this.plot, this.message, this.tooltip.element, this.a11yRoot);
    this.detail = new DetailPanel(() => this.store.setSelection([], { origin: 'shell' }));
    this.toolbar = createToolbar(this.controller.commands());

    this.shadow.append(h('div', { class: styles.root, part: 'root' }, this.toolbar.element, h('div', { class: styles.body }, this.stage, this.detail.element)));

    this.store.subscribe((change) => this.onStoreChange(change));
    this.plot.addEventListener('scroll', () => this.run({ type: 'scroll', top: this.plot.scrollTop }));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Show a pre-built OTel trace. */
  set traceData(data: TraceData) {
    const index = measure('buildSpanIndex', () => buildSpanIndex(data));
    this.store.setData(index);
    this.store.flushSync();
    this.dispatchEvent(new CustomEvent('trace-loaded', {
      detail: { spans: index.size, roots: index.roots.length, traceId: index.traceId },
      bubbles: true,
      composed: true,
    }));
  }

  /** Transform raw logs with a config and show the result. */
  set logData(input: LogDataInput) {
    this.traceData = measure('transformLogs', () => transformLogs(input.logs, input.config));
  }

  /** The shared store: selection, collapse and filter state, and the loaded trace. */
  get traceStore(): TraceStore {
    return this.store;
  }

  /** Select a span and bring it into view. */
  select(id: SpanId): void {
    this.controller.select(id, true);
    this.store.flushSync();
  }

  /** The painter in use. Only the Canvas painter exists so far. */
  get renderer(): 'canvas' {
    return 'canvas';
  }

  /** Parts of the element for tests and the performance harness; not a public API. */
  get internals(): { readonly controller: WaterfallController; readonly store: TraceStore; readonly painter: WaterfallCanvasPainter | null; readonly plot: HTMLElement } {
    return { controller: this.controller, store: this.store, painter: this.mounted?.painter ?? null, plot: this.plot };
  }

  /** What the recent frames cost and how much the painter drew, for the performance harness. */
  frameStats(): { readonly frames: ReturnType<ReturnType<typeof getFrameScheduler>['stats']>; readonly painter: WaterfallCanvasPainter['stats'] | null } {
    return { frames: getFrameScheduler().stats(), painter: this.mounted?.painter.stats ?? null };
  }

  /** Read the theme tokens again and repaint: after the host changed a `--l2t-*` property from script. */
  refreshTheme(): void {
    const mounted = this.mounted;
    if (mounted === null) return;
    mounted.painter.setTheme(mounted.probe.resolve());
    mounted.surface.mark(Dirty.Theme);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  connectedCallback(): void {
    this.mount();
    const url = this.getAttribute('data-url');
    if (url !== null && this.store.state.data.phase === 'empty' && this.store.state.data.index.size === 0) void this.load(url);
  }

  disconnectedCallback(): void {
    this.unmount();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    switch (name) {
      case 'data-url':
        if (this.isConnected && newValue !== null) void this.load(newValue);
        break;
      case 'theme':
        this.refreshTheme();
        break;
      case 'wheel-zoom':
        this.controller.wheelZoom = newValue !== null;
        break;
      case 'span-height':
      case 'span-padding':
      case 'gutter-width':
        this.applyMetrics();
        break;
      default:
        break;
    }
  }

  private mount(): void {
    if (this.mounted !== null) return;
    const scheduler = getFrameScheduler();
    const cleanups: Array<() => void> = [];

    const probe = new ThemeProbe(this.shadow, {
      container: probeStyles.container,
      color: probeStyles.color,
      font: probeStyles.font,
    });
    const measureContext = document.createElement('canvas').getContext('2d');
    if (measureContext === null) throw new Error('trace-visualizer-next needs a 2D canvas');
    const meter = createTextMeter({ measure: measureWithContext(measureContext) });
    const painter = new WaterfallCanvasPainter({ controller: this.controller, meter, theme: probe.resolve() });

    const surface = createCanvasSurface({ host: this.stage, paint: painter.paint, scheduler });
    cleanups.push(surface.onResize((size) => {
      this.apply(this.controller.resize(size.cssWidth, size.cssHeight));
    }));
    cleanups.push(clearOnFontLoad(meter, { onCleared: () => surface.mark(Dirty.Theme) }));
    cleanups.push(bindInput(this.plot, {
      onAction: (action) => this.onAction(action),
      wheelZoom: () => this.controller.wheelZoom,
    }));

    const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (query !== undefined) {
      const onScheme = (): void => this.refreshTheme();
      query.addEventListener('change', onScheme);
      cleanups.push(() => query.removeEventListener('change', onScheme));
    }

    const a11y = scheduler.register({ paint: () => this.renderA11y() });
    this.mounted = { surface, painter, probe, meter, a11y, cleanups };

    this.controller.wheelZoom = this.hasAttribute('wheel-zoom');
    this.applyMetrics();
    this.syncSpacer();
    this.renderPhase();
    this.renderSelection();
    surface.mark(Dirty.All);
    a11y.mark(1);
  }

  private unmount(): void {
    const mounted = this.mounted;
    if (mounted === null) return;
    this.mounted = null;
    for (const cleanup of mounted.cleanups) cleanup();
    mounted.a11y.dispose();
    mounted.surface.dispose();
    mounted.probe.dispose();
    this.tooltip.hide();
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  private async load(url: string): Promise<void> {
    const token = ++this.loadToken;
    this.store.setPhase('loading');
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load: ${response.statusText || response.status}`);
      const data = (await response.json()) as TraceData;
      if (token === this.loadToken) this.traceData = data;
    } catch (error) {
      if (token === this.loadToken) this.store.setPhase('error', error instanceof Error ? error.message : 'Failed to load trace data');
    }
  }

  // ---------------------------------------------------------------------------
  // Store and input
  // ---------------------------------------------------------------------------

  private onStoreChange(change: ChangeSet): void {
    this.apply(this.controller.update(change));
    if (touches(change, Slice.Data)) {
      this.renderPhase();
      this.syncSpacer();
    }
    if (touches(change, Slice.Selection)) {
      this.renderSelection();
      this.mounted?.a11y.mark(1);
      this.announceSelection();
    }
  }

  private announceSelection(): void {
    const primary = this.store.state.selection.primary;
    if (primary === null) return;
    const indexed = this.store.state.data.index.spans.get(primary);
    if (indexed === undefined) return;
    this.dispatchEvent(new CustomEvent('span-selected', { detail: { span: indexed.span, spanId: primary }, bubbles: true, composed: true }));
  }

  /** Run an input through the controller and carry out what it asks for. */
  private run(input: WaterfallInput): boolean {
    const result = this.controller.input(input);
    this.apply({ dirty: result.dirty, scrollTo: result.scrollTo });
    if (result.cursor !== this.cursorName) {
      this.plot.classList.replace(styles.cursor[this.cursorName], styles.cursor[result.cursor]);
      this.cursorName = result.cursor;
    }
    return result.handled;
  }

  private onAction(action: InputAction): boolean {
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
        if (action.dy !== 0) this.plot.scrollTop -= action.dy;
        return true;
      case InputActionKind.Zoom:
        this.run({ type: 'pinch', x: action.x, scale: 1 / action.factor });
        return true;
      case InputActionKind.KeyDown:
        if (action.key === Key.Escape) {
          if (this.store.state.selection.ids.size === 0) return false;
          this.store.setSelection([], { origin: 'shell' });
          return true;
        }
        return this.run({ type: 'key', key: KEY_NAMES[action.key], shift: action.shiftKey, ctrl: false, alt: false });
      default:
        return true;
    }
  }

  /** Carry out what the controller asked for after a change of the store, an input or a resize. */
  private apply(result: UpdateResult): void {
    const { dirty } = result;
    if (dirty === 0 && !result.scrollTo) return;

    if ((dirty & (WaterfallDirty.Rows | WaterfallDirty.Size)) !== 0) this.syncSpacer();
    if (result.scrollTo && this.plot.scrollTop !== this.controller.state.scrollTop) this.plot.scrollTop = this.controller.state.scrollTop;
    if ((dirty & (WaterfallDirty.Camera | WaterfallDirty.Rows)) !== 0) this.toolbar.refresh();

    const mounted = this.mounted;
    if (mounted !== null) {
      mounted.surface.mark(toSurfaceDirty(dirty));
      if ((dirty & (WaterfallDirty.Rows | WaterfallDirty.Scroll | WaterfallDirty.Selection | WaterfallDirty.Size)) !== 0) mounted.a11y.mark(1);
    }
    this.renderTooltip(dirty);
  }

  // ---------------------------------------------------------------------------
  // Rendering of the parts around the canvas
  // ---------------------------------------------------------------------------

  private applyMetrics(): void {
    const num = (name: string): number | undefined => {
      const raw = this.getAttribute(name);
      return raw === null ? undefined : Number(raw);
    };
    const bar = num('span-height');
    const gap = num('span-padding');
    const metrics: Partial<WaterfallMetrics> = {
      ...(bar !== undefined || gap !== undefined ? metricsFromSpanSizes(bar ?? Number.NaN, gap ?? Number.NaN) : {}),
      ...(num('gutter-width') !== undefined ? { gutterWidth: num('gutter-width') } : {}),
    };
    this.apply(this.controller.setMetrics(metrics));
  }

  /** The height of the spacer gives the scroller exactly the scroll range of the rows. */
  private syncSpacer(): void {
    const { layout, projection } = this.controller;
    this.spacer.style.height = `${layout.headerHeight + projection.count * layout.rowHeight}px`;
  }

  private renderPhase(): void {
    const { phase, error } = this.store.state.data;
    const text = phase === 'loading' ? 'Loading trace…' : phase === 'error' ? error ?? 'Failed to load trace data' : phase === 'empty' ? 'No spans to show' : '';
    this.message.hidden = text === '';
    this.message.textContent = text;
    this.message.classList.toggle(styles.messageError, phase === 'error');
  }

  private renderSelection(): void {
    const { selection, data } = this.store.state;
    const primary = selection.primary;
    this.detail.show(primary === null ? null : `${data.generation}:${primary}`, primary === null ? null : describeSpan(data.index, primary, 'full'));
  }

  private renderTooltip(dirty: number): void {
    const hover = this.controller.state.hover;
    if (hover === null || (dirty & (WaterfallDirty.Camera | WaterfallDirty.Scroll | WaterfallDirty.Rows)) !== 0) {
      this.tooltip.hide();
      return;
    }
    const { index } = this.controller;
    const id = index.table.ids[hover.span];
    const model = describeSpan(index, id, 'brief');
    if (model === null) {
      this.tooltip.hide();
      return;
    }
    const { layout } = this.controller;
    this.tooltip.show(`${id}:${hover.event}`, model, hover, { width: layout.width, height: layout.height });
  }

  /** Rebuild the accessibility tree of the rows in view when it changed. */
  private renderA11y(): void {
    const tree = this.controller.a11y('Spans');
    const first = tree.items[0]?.position ?? 0;
    const key = `${tree.size}|${first}|${tree.items.length}|${tree.activeId ?? ''}`;
    if (key === this.a11yKey) return;
    this.a11yKey = key;

    this.a11yRoot.replaceChildren(
      h(
        'div',
        { role: 'tree', 'aria-label': tree.label, 'aria-activedescendant': undefined },
        tree.items.map((item) =>
          h('div', {
            role: 'treeitem',
            'aria-level': item.level + 1,
            'aria-expanded': item.expanded,
            'aria-selected': item.selected,
            'aria-posinset': item.position,
            'aria-setsize': tree.size,
          }, item.label)),
      ),
    );
  }
}

if (!customElements.get('trace-visualizer-next')) customElements.define('trace-visualizer-next', TraceVisualizerNextElement);
