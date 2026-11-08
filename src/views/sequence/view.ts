/**
 * Sequence diagram view: mounts the native 2D scroller (`part="plot"`), binds pointer/wheel/key
 * input, connects `SequenceController` to `SequenceDomPainter` via the shared frame scheduler,
 * and exposes the sequence toolbar commands.
 */

import type { ChangeSet, SpanId } from '../../core.ts';
import type { ViewCommand } from '../../kit/commands.ts';
import { h } from '../../kit/dom.ts';
import { bindInput } from '../../kit/input/bind.ts';
import { InputActionKind, Key, type InputAction } from '../../kit/input/types.ts';
import { getFrameScheduler, type FrameHandle, type FrameScheduler } from '../../kit/scheduler.ts';
import type {
  RendererKind,
  TraceView,
  ViewContext,
  ViewDefinition,
} from '../../kit/view.ts';
import { SequenceController } from './controller.ts';
import { HitKind, type SequenceHit } from './model/hit.ts';
import { SequenceDirty, type SequenceInput } from './model/interaction.ts';
import type { SequenceDomPainter } from './paint/dom.ts';
import { mountSequenceDomPainter } from './paint/dom-mount.ts';
import {
  readSequenceSettings,
  type InternalSpanMode,
  type ReturnArrowMode,
} from './settings.ts';
import * as styles from './view.css.ts';

/** Maps the keys of the input kit to the `KeyboardEvent.key` values the sequence reducer handles. */
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
};

interface MountedSequenceView {
  readonly ctx: ViewContext;
  readonly controller: SequenceController;
  readonly scroller: HTMLElement;
  readonly painter: SequenceDomPainter;
  readonly frame: FrameHandle;
  readonly cleanups: Array<() => void>;
}

/** The sequence diagram view. */
export class SequenceView implements TraceView {
  readonly renderer: RendererKind = 'dom';
  private readonly scheduler: FrameScheduler;
  private mounted: MountedSequenceView | null = null;

  constructor(scheduler: FrameScheduler = getFrameScheduler()) {
    this.scheduler = scheduler;
  }

  /** Parts of the view for tests; not a public API. */
  get internals(): {
    readonly controller: SequenceController;
    readonly painter: SequenceDomPainter;
    readonly scroller: HTMLElement;
    readonly onAction: (action: InputAction) => boolean;
  } | null {
    const m = this.mounted;
    return m === null
      ? null
      : {
          controller: m.controller,
          painter: m.painter,
          scroller: m.scroller,
          onAction: (action: InputAction) => this.onAction(action),
        };
  }

  mount(surface: HTMLElement, ctx: ViewContext): void {
    if (this.mounted !== null) return;

    const settings = readSequenceSettings(ctx.options());
    const controller = new SequenceController({
      store: ctx.store,
      origin: ctx.origin,
      settings,
      onHover: (hit) => this.reportHover(hit),
      onScrollTo: (top, left) => this.scrollTo(top, left),
    });

    const scroller = h('div', {
      class: styles.scroller,
      part: 'plot',
      tabindex: 0,
      role: 'treegrid',
      'aria-label': 'Sequence diagram',
    });
    surface.append(scroller);

    const painter = mountSequenceDomPainter({ host: scroller });
    const frame = this.scheduler.register({
      paint: (dirty) => this.paint(dirty),
    });
    const cleanups: Array<() => void> = [];

    this.mounted = {
      ctx,
      controller,
      scroller,
      painter,
      frame,
      cleanups,
    };

    const observer = new ResizeObserver((entries) => {
      const m = this.mounted;
      if (m === null) return;
      const rect = entries[0]?.contentRect;
      const width =
        rect !== undefined && rect.width > 0 ? rect.width : m.scroller.clientWidth;
      const height =
        rect !== undefined && rect.height > 0 ? rect.height : m.scroller.clientHeight;
      this.dispatchInput({ type: 'resize', width, height });
    });
    observer.observe(scroller);
    cleanups.push(() => observer.disconnect());

    const onScroll = (): void => {
      this.dispatchInput({
        type: 'scroll',
        scrollTop: scroller.scrollTop,
        scrollLeft: scroller.scrollLeft,
      });
    };
    scroller.addEventListener('scroll', onScroll);
    cleanups.push(() => scroller.removeEventListener('scroll', onScroll));

    cleanups.push(
      bindInput(scroller, {
        onAction: (action) => this.onAction(action),
        wheelZoom: () => controller.wheelZoom,
      }),
    );

    if (scroller.clientWidth > 0 || scroller.clientHeight > 0) {
      controller.handleInput({
        type: 'resize',
        width: scroller.clientWidth,
        height: scroller.clientHeight,
      });
    }
    this.schedulePaint(controller.dirty);
  }

  unmount(): void {
    const m = this.mounted;
    if (m === null) return;
    this.mounted = null;
    for (const cleanup of m.cleanups) cleanup();
    m.frame.dispose();
    m.painter.destroy();
    m.scroller.remove();
    m.ctx.store.setHover(null, { origin: m.ctx.origin });
    m.ctx.hover(null);
  }

  update(change: ChangeSet): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.handleStoreChange(change);
    if (dirty !== SequenceDirty.None) {
      this.schedulePaint(dirty);
    }
  }

  optionsChanged(): void {
    const m = this.mounted;
    if (m === null) return;
    const settings = readSequenceSettings(m.ctx.options());
    const dirty = m.controller.applySettings(settings);
    this.schedulePaint(dirty);
    m.ctx.refreshCommands();
  }

  themeChanged(): void {
    const m = this.mounted;
    if (m === null) return;
    m.controller.dirty |= SequenceDirty.Theme;
    this.schedulePaint(SequenceDirty.Theme);
  }

  commands(): readonly ViewCommand[] {
    const m = this.mounted;
    if (m === null) return [];
    const { controller } = m;
    return [
      {
        id: 'sequence.internal',
        label: 'Internal spans',
        keys: ['i', 'I'],
        readout: () => controller.viewState.internal,
        run: () => this.cycleInternal(),
      },
      {
        id: 'sequence.returns',
        label: 'Returns',
        readout: () => controller.viewState.returns,
        run: () => this.cycleReturns(),
      },
      {
        id: 'sequence.matches-only',
        label: 'Matches only',
        readout: () => (controller.viewState.matchesOnly ? 'on' : 'off'),
        run: () => this.toggleMatchesOnly(),
      },
      {
        id: 'sequence.hide-unaffected',
        label: 'Active lifelines',
        readout: () => (controller.viewState.hideUnaffectedColumns ? 'active' : 'all'),
        run: () => this.toggleHideUnaffectedColumns(),
      },
      {
        id: 'sequence.fit-columns',
        label: 'Fit columns',
        keys: ['f', 'F'],
        readout: () => (controller.viewState.fitColumns ? 'fit' : 'fixed'),
        run: () => this.toggleFitColumns(),
      },
      {
        id: 'sequence.density-out',
        label: 'Density −',
        keys: ['-'],
        run: () => this.zoomDensity(1 / 1.15),
      },
      {
        id: 'sequence.density-in',
        label: 'Density +',
        keys: ['=', '+'],
        run: () => this.zoomDensity(1.15),
      },
    ];
  }

  reveal(id: SpanId): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.revealSpan(id);
    if (dirty !== SequenceDirty.None) {
      this.schedulePaint(dirty);
    }
  }

  focus(): void {
    this.mounted?.scroller.focus({ preventScroll: true });
  }

  getState(): unknown {
    return this.mounted?.controller.getState() ?? null;
  }

  setState(state: unknown): void {
    const m = this.mounted;
    if (m === null) return;
    m.controller.setState(state);
    this.schedulePaint(m.controller.dirty);
    m.ctx.refreshCommands();
  }

  // ---------------------------------------------------------------------------
  // Command helpers
  // ---------------------------------------------------------------------------

  private cycleInternal(): void {
    const m = this.mounted;
    if (m === null) return;
    const cur = m.controller.viewState.internal;
    const next: InternalSpanMode =
      cur === 'auto' ? 'show' : cur === 'show' ? 'hide' : 'auto';
    const dirty = m.controller.setInternalMode(next);
    this.schedulePaint(dirty);
    m.ctx.refreshCommands();
  }

  private cycleReturns(): void {
    const m = this.mounted;
    if (m === null) return;
    const cur = m.controller.viewState.returns;
    const next: ReturnArrowMode =
      cur === 'all' ? 'errors' : cur === 'errors' ? 'none' : 'all';
    const dirty = m.controller.setReturnsMode(next);
    this.schedulePaint(dirty);
    m.ctx.refreshCommands();
  }

  private toggleMatchesOnly(): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.toggleMatchesOnly();
    this.schedulePaint(dirty);
    m.ctx.refreshCommands();
  }

  private toggleHideUnaffectedColumns(): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.toggleHideUnaffectedColumns();
    this.schedulePaint(dirty);
    m.ctx.refreshCommands();
  }

  private toggleFitColumns(): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.toggleFitColumns();
    this.schedulePaint(dirty);
    m.ctx.refreshCommands();
  }

  private zoomDensity(factor: number): void {
    const m = this.mounted;
    if (m === null) return;
    const dirty = m.controller.zoomDensity(factor);
    this.schedulePaint(dirty);
    m.ctx.refreshCommands();
  }

  // ---------------------------------------------------------------------------
  // Input, hover, scroll & paint
  // ---------------------------------------------------------------------------

  private onAction(action: InputAction): boolean {
    const m = this.mounted;
    if (m === null) return false;
    switch (action.kind) {
      case InputActionKind.Hover:
        return this.dispatchInput({
          type: 'hover',
          hit: m.controller.hitTest(action.x, action.y),
        });
      case InputActionKind.HoverEnd:
        return this.dispatchInput({ type: 'leave' });
      case InputActionKind.Click:
        return this.dispatchInput({
          type: 'click',
          hit: m.controller.hitTest(action.x, action.y),
        });
      case InputActionKind.DoubleClick:
        return this.dispatchInput({
          type: 'dblclick',
          hit: m.controller.hitTest(action.x, action.y),
        });
      case InputActionKind.PanStart:
        m.scroller.classList.add(styles.panning);
        return true;
      case InputActionKind.Pan:
        return this.dispatchInput({ type: 'pan', dx: action.dx, dy: action.dy });
      case InputActionKind.PanEnd:
        m.scroller.classList.remove(styles.panning);
        return true;
      case InputActionKind.Zoom:
        return this.dispatchInput({
          type: 'zoom-density',
          factor: action.factor,
          anchorY: action.y,
        });
      case InputActionKind.KeyDown: {
        if (action.key === Key.I) {
          this.cycleInternal();
          return true;
        }
        if (action.key === Key.F) {
          this.toggleFitColumns();
          return true;
        }
        const keyName = KEY_NAMES[action.key];
        if (keyName === '+') {
          this.zoomDensity(1.15);
          return true;
        }
        if (keyName === '-') {
          this.zoomDensity(1 / 1.15);
          return true;
        }
        const prevInternal = m.controller.viewState.internal;
        const handled = this.dispatchInput({
          type: 'key',
          key: keyName,
          shiftKey: action.shiftKey,
        });
        if (m.controller.viewState.internal !== prevInternal) {
          m.ctx.refreshCommands();
        }
        return handled;
      }
      default:
        return true;
    }
  }

  private dispatchInput(input: SequenceInput): boolean {
    const m = this.mounted;
    if (m === null) return false;
    const result = m.controller.handleInput(input);
    if (result.dirty !== SequenceDirty.None) {
      this.schedulePaint(result.dirty);
    }
    return result.handled;
  }

  private scrollTo(top: number, left?: number): void {
    const m = this.mounted;
    if (m === null) return;
    if (m.scroller.scrollTop !== top) {
      m.scroller.scrollTop = top;
    }
    if (left !== undefined && m.scroller.scrollLeft !== left) {
      m.scroller.scrollLeft = left;
    }
  }

  private reportHover(hit: SequenceHit | null): void {
    const m = this.mounted;
    if (m === null) return;
    if (hit === null || hit.kind === HitKind.None) {
      m.ctx.hover(null);
      return;
    }
    const { controller, ctx } = m;
    const generation = ctx.store.state.data.generation;
    const key = `${generation}:${hit.kind}:${hit.index}:${hit.row}:${hit.eventIdx}`;
    ctx.hover({
      key,
      anchor: hit.anchor,
      bounds: {
        width: controller.viewState.viewWidth,
        height: controller.viewState.viewHeight,
      },
      info: () => controller.describeHit(hit),
    });
  }

  private schedulePaint(dirty: number): void {
    const m = this.mounted;
    if (m === null || dirty === SequenceDirty.None) return;
    m.frame.mark(dirty);
  }

  private paint(dirty: number): void {
    const m = this.mounted;
    if (m === null) return;
    const combined = dirty | m.controller.dirty;
    if (combined === SequenceDirty.None) return;
    const plan = m.controller.buildPlan();
    m.painter.paint(plan, combined);
    const focusStep = m.controller.viewState.focusStep;
    const activeId = focusStep >= 0 ? `l2t-seq-step-${focusStep}` : '';
    m.scroller.setAttribute('aria-activedescendant', activeId);
  }
}

/** The sequence diagram, as the element lists it. */
export const sequenceDefinition: ViewDefinition = {
  id: 'sequence',
  label: 'Sequence',
  renderers: ['dom'],
  capabilities: { legend: true },
  create: () => new SequenceView(),
};
