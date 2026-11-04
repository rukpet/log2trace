/**
 * Waterfall painter for Canvas 2D.
 *
 * Turns what the headless model decided into pixels. It owns no state of its own beyond the
 * frame plan and the resolved theme: everything it draws comes from the controller (rows,
 * camera, scroll position, selection, hover), so redrawing at any moment gives the same picture.
 *
 * Two layers, because they change at different rates:
 * - the scene (opaque): background, ruler, grid, bars, event markers, duration texts and the
 *   gutter with chevrons and labels. Redrawn whenever the rows, the camera, the scroll position,
 *   the size or the theme change. Only the rows in view are drawn, so the cost follows the screen,
 *   not the 50,000 spans behind it.
 * - the overlay (transparent): the hover band, the selection band and the outline of selected bars.
 *   Redrawn on every scene redraw and, alone, when only the selection or the hover changed, which
 *   is why moving the pointer over rows never repaints the scene.
 *
 * The painter is a function of the surface's dirty bits (`paint`); the element feeds it the
 * controller's {@link WaterfallDirty} bits translated with {@link toSurfaceDirty}.
 */

import { niceTicks } from '../../../kit/geometry/ticks.ts';
import { timeToPx } from '../../../kit/geometry/camera1d.ts';
import type { CanvasSurface } from '../../../kit/canvas/surface.ts';
import type { TextMeter } from '../../../kit/canvas/text-cache.ts';
import { Dirty } from '../../../kit/scheduler.ts';
import type { ResolvedTheme } from '../../../kit/theme/theme.ts';
import type { WaterfallController } from '../controller.ts';
import { HitPart } from '../model/hit.ts';
import { WaterfallDirty } from '../model/interaction.ts';
import { chevronX, labelWidth, labelX, CHEVRON_SIZE } from '../model/layout.ts';
import { FramePlan, LabelMode, RowFlag } from '../model/plan.ts';
import { Chevron } from '../model/rows.ts';

/** The surface bits that need the scene redrawn. */
const SCENE_BITS = Dirty.Size | Dirty.Theme | Dirty.Rows | Dirty.Scroll | Dirty.Camera;
/** The surface bits that need the overlay redrawn. */
const OVERLAY_BITS = SCENE_BITS | Dirty.Selection | Dirty.Hover;

/** Font sizes, px. */
const LABEL_SIZE = 12;
const SMALL_SIZE = 11;

/** Opacity of rows that are only the ancestors of a filter match. */
const CONTEXT_ALPHA = 0.5;

/** The `WaterfallDirty` bits of the controller as the surface's {@link Dirty} bits. */
export function toSurfaceDirty(bits: number): number {
  let out = 0;
  if (bits & WaterfallDirty.Rows) out |= Dirty.Rows;
  if (bits & WaterfallDirty.Scroll) out |= Dirty.Scroll;
  if (bits & WaterfallDirty.Camera) out |= Dirty.Camera;
  if (bits & WaterfallDirty.Selection) out |= Dirty.Selection;
  if (bits & WaterfallDirty.Hover) out |= Dirty.Hover;
  if (bits & WaterfallDirty.Theme) out |= Dirty.Theme;
  if (bits & WaterfallDirty.Size) out |= Dirty.Size;
  return out;
}

/** What the painter is made of. */
export interface CanvasPainterOptions {
  readonly controller: WaterfallController;
  /** Caches text widths; clear it when fonts load or the theme changes. */
  readonly meter: TextMeter;
  /** The tokens as the browser resolved them. */
  readonly theme: ResolvedTheme;
}

/** Counters for the harness: what the last frames cost in drawing work. */
export interface PainterStats {
  /** Scene redraws so far. */
  scenes: number;
  /** Overlay redraws so far. */
  overlays: number;
  /** Rows drawn by the last scene redraw. */
  rows: number;
}

/** Draws the waterfall on a {@link CanvasSurface}. */
export class WaterfallCanvasPainter {
  readonly stats: PainterStats = { scenes: 0, overlays: 0, rows: 0 };

  private readonly controller: WaterfallController;
  private readonly meter: TextMeter;
  private readonly plan = new FramePlan();
  private theme: ResolvedTheme;
  private labelFont = '';
  private smallFont = '';

  constructor(options: CanvasPainterOptions) {
    this.controller = options.controller;
    this.meter = options.meter;
    this.theme = options.theme;
    this.setFonts();
  }

  /** The plan of the last scene redraw, for tests and the harness. */
  get lastPlan(): FramePlan {
    return this.plan;
  }

  /** Use another resolved theme; mark `Dirty.Theme` afterwards. */
  setTheme(theme: ResolvedTheme): void {
    this.theme = theme;
    this.meter.clear();
    this.setFonts();
  }

  private setFonts(): void {
    const family = this.theme.fonts.sans;
    this.labelFont = `${LABEL_SIZE}px ${family}`;
    this.smallFont = `${SMALL_SIZE}px ${family}`;
  }

  /** Draw what the bits name; the callback of {@link CanvasSurface}. */
  paint = (dirty: number, surface: CanvasSurface): void => {
    if (this.controller.layout.width === 0 || this.controller.layout.height === 0) return;
    if ((dirty & Dirty.Theme) !== 0) this.meter.clear();

    if ((dirty & SCENE_BITS) !== 0) {
      this.controller.buildPlan(this.plan, (text) => this.meter.measure(text, this.smallFont));
      surface.applyScale(surface.scene);
      this.drawScene(surface.scene);
    }
    if ((dirty & OVERLAY_BITS) !== 0) {
      surface.applyScale(surface.overlay);
      this.drawOverlay(surface.overlay);
    }
  };

  private drawScene(ctx: CanvasRenderingContext2D): void {
    const { controller, plan, theme } = this;
    const layout = controller.layout;
    const camera = controller.state.camera;
    const table = controller.index.table;
    const { colors, kindColors } = theme;
    const { width, height, headerHeight, bodyHeight, plotLeft, plotWidth, rowHeight, barHeight, barInset } = layout;
    const half = rowHeight / 2;

    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const ticks = plotWidth > 0 ? niceTicks(camera.t0, camera.t1, plotWidth).ticks : [];

    // ---- body: grid, bars, markers, texts (clipped to the plot) ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, headerHeight, plotWidth + 1, bodyHeight);
    ctx.clip();

    ctx.fillStyle = colors.grid;
    for (let i = 0; i < ticks.length; i++) {
      ctx.fillRect(Math.round(plotLeft + timeToPx(camera, ticks[i].value)), headerHeight, 1, bodyHeight);
    }

    ctx.textBaseline = 'middle';
    ctx.font = this.smallFont;
    const insideText = theme.dark ? '#111' : '#fff';
    for (let j = 0; j < plan.count; j++) {
      const flags = plan.flags[j];
      if ((flags & RowFlag.BarVisible) === 0) continue;
      const y = plan.y[j];
      const x0 = plotLeft + plan.barX0[j];
      const w = plan.barX1[j] - plan.barX0[j];
      const dim = (flags & RowFlag.Context) !== 0;
      if (dim) ctx.globalAlpha = CONTEXT_ALPHA;

      ctx.fillStyle = kindColors[plan.kind[j]] ?? kindColors[0];
      fillBar(ctx, x0, y + barInset, w, barHeight);

      if ((flags & RowFlag.Error) !== 0) {
        ctx.fillStyle = colors.error;
        ctx.fillRect(Math.max(x0, plotLeft), y + barInset, Math.min(3, w), barHeight);
      }

      const first = plan.evOff[j];
      const last = plan.evOff[j + 1];
      if (last > first) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        for (let k = first; k < last; k++) ctx.fillRect(plotLeft + plan.evX[k] - 1, y + barInset, 2, barHeight);
      }

      const mode = plan.labelMode[j];
      if (mode !== LabelMode.Hidden) {
        ctx.fillStyle = mode === LabelMode.Inside ? insideText : colors.textMuted;
        ctx.fillText(plan.durationText[j], plotLeft + plan.labelX[j], y + half);
      }
      if (dim) ctx.globalAlpha = 1;
    }
    ctx.restore();

    // ---- gutter: chevrons and labels (clipped to the column) ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, headerHeight, plotLeft, bodyHeight);
    ctx.clip();
    ctx.textBaseline = 'middle';
    for (let j = 0; j < plan.count; j++) {
      const span = plan.idx[j];
      const flags = plan.flags[j];
      const depth = table.depth[span];
      const y = plan.y[j];
      const dim = (flags & RowFlag.Context) !== 0;
      if (dim) ctx.globalAlpha = CONTEXT_ALPHA;

      const chevron = plan.chevron[j];
      if (chevron !== Chevron.None) {
        const cx = chevronX(layout, depth) + CHEVRON_SIZE / 2;
        drawChevron(ctx, cx, y + half, chevron === Chevron.Expanded, colors.textMuted);
      }

      const room = labelWidth(layout, depth);
      if (room > 0) {
        const x = labelX(layout, depth);
        const error = (flags & RowFlag.Error) !== 0;
        ctx.font = this.labelFont;
        const name = table.names[table.nameId[span]];
        const shown = this.meter.fit(name, this.labelFont, room);
        ctx.fillStyle = error ? colors.error : colors.text;
        ctx.fillText(shown, x, y + half);

        if (shown === name) {
          const used = this.meter.measure(name, this.labelFont);
          const left = room - used - 6;
          if (left > 24) {
            const service = this.meter.fit(table.services[table.svc[span]], this.smallFont, left);
            if (service !== '') {
              ctx.font = this.smallFont;
              ctx.fillStyle = colors.textMuted;
              ctx.fillText(service, x + used + 6, y + half);
            }
          }
        }
      }
      if (dim) ctx.globalAlpha = 1;
    }
    ctx.restore();

    // ---- ruler ----
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = colors.border;
    ctx.fillRect(0, headerHeight - 1, width, 1);
    ctx.fillRect(plotLeft - 1, 0, 1, height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, 0, plotWidth + 24, headerHeight);
    ctx.clip();
    ctx.font = this.smallFont;
    ctx.textBaseline = 'top';
    for (let i = 0; i < ticks.length; i++) {
      const x = Math.round(plotLeft + timeToPx(camera, ticks[i].value));
      ctx.fillStyle = colors.border;
      ctx.fillRect(x, 0, 1, headerHeight);
      ctx.fillStyle = colors.textMuted;
      ctx.fillText(ticks[i].label, x + 5, 5);
    }
    ctx.restore();

    this.stats.scenes++;
    this.stats.rows = plan.count;
  }

  private drawOverlay(ctx: CanvasRenderingContext2D): void {
    const { controller, plan, theme } = this;
    const { width, height, headerHeight, bodyHeight, plotLeft, rowHeight, barHeight, barInset } = controller.layout;
    const { colors } = theme;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, headerHeight, width, bodyHeight);
    ctx.clip();

    for (let j = 0; j < plan.count; j++) {
      const span = plan.idx[j];
      const selected = controller.isSelected(span);
      const hovered = controller.isHovered(span);
      if (!selected && !hovered) continue;
      const y = plan.y[j];

      if (hovered) {
        ctx.fillStyle = colors.hover;
        ctx.fillRect(0, y, width, rowHeight);
      }
      if (selected) {
        ctx.fillStyle = colors.selection;
        ctx.fillRect(0, y, width, rowHeight);
        if ((plan.flags[j] & RowFlag.BarVisible) !== 0) {
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = 2;
          ctx.strokeRect(plotLeft + plan.barX0[j] - 1, y + barInset - 1, plan.barX1[j] - plan.barX0[j] + 2, barHeight + 2);
        }
      }
    }

    const hover = controller.state.hover;
    if (hover !== null && hover.part === HitPart.Event) {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(hover.x + 0.5, hover.y + 0.5, hover.w - 1, hover.h - 1);
    }
    ctx.restore();
    this.stats.overlays++;
  }
}

function fillBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  if (w >= 6 && typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 3);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
}

/** A small triangle, pointing down when expanded and right when collapsed, centred on (`cx`, `cy`). */
function drawChevron(ctx: CanvasRenderingContext2D, cx: number, cy: number, expanded: boolean, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (expanded) {
    ctx.moveTo(cx - 4, cy - 2);
    ctx.lineTo(cx + 4, cy - 2);
    ctx.lineTo(cx, cy + 3);
  } else {
    ctx.moveTo(cx - 2, cy - 4);
    ctx.lineTo(cx + 3, cy);
    ctx.lineTo(cx - 2, cy + 4);
  }
  ctx.closePath();
  ctx.fill();
}
