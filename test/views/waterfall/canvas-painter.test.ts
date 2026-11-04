/**
 * The Canvas painter against a recording context: what it draws, what it leaves alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpanIndex, createTraceStore, type TraceStore } from '../../../src/core.ts';
import type { CanvasSurface } from '../../../src/kit/canvas/surface.ts';
import { createTextMeter } from '../../../src/kit/canvas/text-cache.ts';
import { Dirty } from '../../../src/kit/scheduler.ts';
import { COLOR_TOKENS, KIND_TOKENS, type ColorToken, type ResolvedTheme } from '../../../src/kit/theme/theme.ts';
import { WaterfallController } from '../../../src/views/waterfall/controller.ts';
import { WaterfallDirty } from '../../../src/views/waterfall/model/interaction.ts';
import { WaterfallCanvasPainter, toSurfaceDirty } from '../../../src/views/waterfall/paint/canvas.ts';
import { treeTrace, type TreeNode } from '../../support/trace-builder.ts';

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
}

/** A 2D context that remembers every call together with the fill and stroke style it was made with. */
class RecordingContext {
  readonly calls: Call[] = [];
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  font = '';
  globalAlpha = 1;
  lineWidth = 1;
  textBaseline = '';

  clear(): void {
    this.calls.length = 0;
  }

  of(op: string): Call[] {
    return this.calls.filter((call) => call.op === op);
  }

  private record(op: string, args: unknown[]): void {
    this.calls.push({ op, args, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle });
  }

  fillRect(...args: unknown[]): void { this.record('fillRect', args); }
  strokeRect(...args: unknown[]): void { this.record('strokeRect', args); }
  clearRect(...args: unknown[]): void { this.record('clearRect', args); }
  fillText(...args: unknown[]): void { this.record('fillText', args); }
  roundRect(...args: unknown[]): void { this.record('roundRect', args); }
  fill(...args: unknown[]): void { this.record('fill', args); }
  beginPath(): void { this.record('beginPath', []); }
  closePath(): void { this.record('closePath', []); }
  moveTo(...args: unknown[]): void { this.record('moveTo', args); }
  lineTo(...args: unknown[]): void { this.record('lineTo', args); }
  rect(...args: unknown[]): void { this.record('rect', args); }
  clip(): void { this.record('clip', []); }
  save(): void { this.record('save', []); }
  restore(): void { this.record('restore', []); }
  measureText(text: string): { width: number } { return { width: text.length * 6 }; }
}

const theme: ResolvedTheme = (() => {
  const colors = {} as Record<ColorToken, string>;
  for (const token of COLOR_TOKENS) colors[token] = `color:${token}`;
  return {
    colors,
    fonts: { sans: 'Test Sans', mono: 'Test Mono' },
    kindColors: KIND_TOKENS.map((token) => colors[token]),
    dark: false,
  };
})();

interface Rig {
  readonly store: TraceStore;
  readonly controller: WaterfallController;
  readonly painter: WaterfallCanvasPainter;
  readonly scene: RecordingContext;
  readonly overlay: RecordingContext;
  readonly surface: CanvasSurface;
}

function rig(tree: TreeNode, height = 600): Rig {
  const store = createTraceStore({ schedule: () => undefined });
  store.setData(buildSpanIndex(treeTrace(tree)));
  const controller = new WaterfallController({ store, origin: 'wf-test' });
  controller.resize(1000, height);

  const scene = new RecordingContext();
  const overlay = new RecordingContext();
  const surface = {
    scene,
    overlay,
    applyScale: () => undefined,
  } as unknown as CanvasSurface;
  const meter = createTextMeter({ measure: (text) => text.length * 6 });
  const painter = new WaterfallCanvasPainter({ controller, meter, theme });
  return { store, controller, painter, scene, overlay, surface };
}

/** A root with `children` leaf children, one millisecond each. */
function wide(children: number): TreeNode {
  return {
    id: 'root', start: 0, end: children + 1,
    children: Array.from({ length: children }, (_, i) => ({ id: `s${i}`, start: i, end: i + 1 })),
  };
}

test('toSurfaceDirty maps every waterfall bit to its surface bit', () => {
  assert.equal(toSurfaceDirty(0), 0);
  assert.equal(toSurfaceDirty(WaterfallDirty.Rows), Dirty.Rows);
  assert.equal(toSurfaceDirty(WaterfallDirty.Scroll), Dirty.Scroll);
  assert.equal(toSurfaceDirty(WaterfallDirty.Camera), Dirty.Camera);
  assert.equal(toSurfaceDirty(WaterfallDirty.Selection), Dirty.Selection);
  assert.equal(toSurfaceDirty(WaterfallDirty.Hover), Dirty.Hover);
  assert.equal(toSurfaceDirty(WaterfallDirty.Theme), Dirty.Theme);
  assert.equal(toSurfaceDirty(WaterfallDirty.Size), Dirty.Size);
  assert.equal(
    toSurfaceDirty(WaterfallDirty.Rows | WaterfallDirty.Camera),
    Dirty.Rows | Dirty.Camera,
  );
});

test('a view without a size paints nothing', () => {
  const r = rig(wide(5));
  r.controller.resize(0, 0);
  r.painter.paint(Dirty.All, r.surface);
  assert.equal(r.scene.calls.length, 0);
  assert.equal(r.overlay.calls.length, 0);
});

test('the scene draws only the rows in view, however many there are', () => {
  const r = rig(wide(5000), 400);
  r.painter.paint(Dirty.All, r.surface);

  // body height 360 px / 35 px per row = 10.3 rows
  assert.ok(r.painter.stats.rows >= 10 && r.painter.stats.rows <= 12, `rows drawn: ${r.painter.stats.rows}`);
  const labels = r.scene.of('fillText').filter((call) => /^(s\d+|root)$/.test(String(call.args[0])));
  assert.ok(labels.length <= 12, `gutter labels: ${labels.length}`);
});

test('a bar is filled with the colour of its kind and the first row is the root', () => {
  const r = rig({ id: 'root', start: 0, end: 10, children: [{ id: 'child', start: 2, end: 6 }] });
  r.painter.paint(Dirty.All, r.surface);

  const filled = r.scene.of('fill').concat(r.scene.of('fillRect'));
  assert.ok(filled.some((call) => call.fillStyle === theme.kindColors[0] || call.fillStyle === theme.kindColors[1]));
  const texts = r.scene.of('fillText').map((call) => call.args[0]);
  assert.ok(texts.includes('root'), `texts: ${texts.join(', ')}`);
});

test('a selection redraws the overlay and leaves the scene alone', () => {
  const r = rig(wide(20));
  r.painter.paint(Dirty.All, r.surface);
  const { scenes, overlays } = r.painter.stats;
  r.scene.clear();
  r.overlay.clear();

  r.store.setSelection(['s3'], { origin: 'api' });
  r.painter.paint(Dirty.Selection, r.surface);

  assert.equal(r.painter.stats.scenes, scenes, 'scene not redrawn');
  assert.equal(r.painter.stats.overlays, overlays + 1);
  assert.equal(r.scene.calls.length, 0);
  assert.ok(r.overlay.of('fillRect').some((call) => call.fillStyle === theme.colors.selection), 'selection band');
  assert.ok(r.overlay.of('strokeRect').some((call) => call.strokeStyle === theme.colors.accent), 'bar outline');
});

test('a hover redraws only the overlay and draws the hover band', () => {
  const r = rig(wide(20));
  r.painter.paint(Dirty.All, r.surface);
  r.scene.clear();
  r.overlay.clear();

  r.store.setHover(['s2'], { origin: 'api' });
  r.painter.paint(Dirty.Hover, r.surface);

  assert.equal(r.scene.calls.length, 0);
  assert.ok(r.overlay.of('fillRect').some((call) => call.fillStyle === theme.colors.hover));
});

test('scrolling redraws the scene with other rows', () => {
  const r = rig(wide(500), 400);
  r.painter.paint(Dirty.All, r.surface);
  const before = r.scene.of('fillText').map((call) => call.args[0]).join('|');
  r.scene.clear();

  r.controller.input({ type: 'scroll', top: 35 * 100 });
  r.painter.paint(Dirty.Scroll, r.surface);
  const after = r.scene.of('fillText').map((call) => call.args[0]).join('|');

  assert.notEqual(before, after);
  assert.ok(after.includes('s99') || after.includes('s100'), after);
  assert.equal(r.painter.lastPlan.firstRow, 100);
});

test('changing the theme clears the text cache and repaints with the new colours', () => {
  const r = rig(wide(5));
  r.painter.paint(Dirty.All, r.surface);
  r.scene.clear();

  const next: ResolvedTheme = { ...theme, colors: { ...theme.colors, background: 'color:other' } };
  r.painter.setTheme(next);
  r.painter.paint(Dirty.Theme, r.surface);

  assert.equal(r.scene.of('fillRect')[0].fillStyle, 'color:other');
});
