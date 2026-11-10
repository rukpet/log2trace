/**
 * Adversarial View and Option Probing Test Suite
 *
 * Empirical verification of:
 * 1. Boundary values for view options (sequence-internal, sequence-returns, sequence-fold, row-height).
 * 2. Trace visualizer events (trace-loaded payload, span-selected detail payload).
 * 3. HTML validity across demo/guide.html and demo/demo.html.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

import type { ViewOptions } from '../src/kit/view-options.ts';
import { readSequenceSettings } from '../src/views/sequence/settings.ts';
import {
  ROW_H_DEFAULT,
  ROW_H_MAX,
  ROW_H_MIN,
  CANVAS_PAD_Y,
  computeSequenceLayout,
  stepAtBodyY,
  stepRowY,
} from '../src/views/sequence/model/layout.ts';
import { buildSequenceModel } from '../src/views/sequence/model/messages.ts';
import {
  StepKind,
  projectSteps,
} from '../src/views/sequence/model/steps.ts';
import {
  SpanKind,
  buildSpanIndex,
  createTraceStore,
} from '../src/core.ts';
import { span, trace } from './support/trace-builder.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function makeOptions(
  config: Record<string, unknown> = {},
  attrs: Record<string, string> = {},
): ViewOptions {
  return {
    config,
    attribute(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? (attrs[name] ?? null) : null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1: Boundary values for view options
// ─────────────────────────────────────────────────────────────────────────────

describe('Adversarial Probe 1: View Options Boundary Values', () => {
  describe('sequence-internal option', () => {
    it('defaults to auto when unconfigured', () => {
      const s = readSequenceSettings(makeOptions());
      assert.equal(s.internal, 'auto');
    });

    it('accepts valid modes from attribute or config', () => {
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-internal': 'auto' })).internal, 'auto');
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-internal': 'hide' })).internal, 'hide');
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-internal': 'show' })).internal, 'show');
      assert.equal(readSequenceSettings(makeOptions({ sequenceInternal: 'hide' })).internal, 'hide');
      assert.equal(readSequenceSettings(makeOptions({ sequenceInternal: 'show' })).internal, 'show');
    });

    it('falls back to default auto on boundary, invalid, or malformed inputs', () => {
      const bad = ['', 'AUTO', 'HIDE', 'SHOW', '  show  ', 'invalid', 'null', 'undefined', '0', 'true'];
      for (const val of bad) {
        assert.equal(
          readSequenceSettings(makeOptions({}, { 'sequence-internal': val })).internal,
          'auto',
          `attribute sequence-internal="${val}" must fall back to auto`
        );
      }
      for (const val of [123, true, null, undefined, {}, []]) {
        assert.equal(
          readSequenceSettings(makeOptions({ sequenceInternal: val as unknown as string })).internal,
          'auto',
          `config sequenceInternal=${String(val)} must fall back to auto`
        );
      }
    });

    it('correctly modulates step projection in single-participant vs multi-participant traces', () => {
      // Single-participant trace
      const singleIndex = buildSpanIndex(
        trace([
          'service-a',
          [
            span('root', undefined, 0, 100, { name: 'HTTP GET', kind: SpanKind.Server }),
            span('int1', 'root', 10, 40, { name: 'computeInternal', kind: SpanKind.Internal }),
          ],
        ])
      );
      const singleModel = buildSequenceModel(singleIndex);
      assert.equal(singleModel.singleParticipant, true);

      // Auto shows internal for single participant
      const autoSingle = projectSteps(singleModel, null, null, null, { internal: 'auto' });
      assert.equal(autoSingle.count, 3); // Found, SelfCall, Return
      assert.equal(autoSingle.kind[1], StepKind.SelfCall);

      // Hide suppresses internal even for single participant
      const hideSingle = projectSteps(singleModel, null, null, null, { internal: 'hide' });
      assert.equal(hideSingle.count, 2); // Found, Return (int1 suppressed)

      // Multi-participant trace
      const multiIndex = buildSpanIndex(
        trace(
          [
            'service-a',
            [
              span('a-root', undefined, 0, 100, { name: 'HTTP GET', kind: SpanKind.Server }),
              span('a-int', 'a-root', 5, 20, { name: 'authCheck', kind: SpanKind.Internal }),
              span('a-cli', 'a-root', 25, 90, { name: 'call-b', kind: SpanKind.Client }),
            ],
          ],
          [
            'service-b',
            [span('b-srv', 'a-cli', 30, 85, { name: 'process', kind: SpanKind.Server })],
          ]
        )
      );
      const multiModel = buildSequenceModel(multiIndex);
      assert.equal(multiModel.singleParticipant, false);

      // Auto hides internal for multi-participant
      const autoMulti = projectSteps(multiModel, null, null, null, { internal: 'auto' });
      const hasAuthAuto = Array.from({ length: autoMulti.count }).some((_, i) => autoMulti.row[i] === multiIndex.spans.get('a-int')?.idx);
      assert.equal(hasAuthAuto, false, 'auto must hide internal in multi-participant');

      // Show reveals internal in multi-participant
      const showMulti = projectSteps(multiModel, null, null, null, { internal: 'show' });
      const hasAuthShow = Array.from({ length: showMulti.count }).some((_, i) => showMulti.row[i] === multiIndex.spans.get('a-int')?.idx);
      assert.equal(hasAuthShow, true, 'show must reveal internal in multi-participant');
    });
  });

  describe('sequence-returns option', () => {
    it('defaults to all when unconfigured', () => {
      const s = readSequenceSettings(makeOptions());
      assert.equal(s.returns, 'all');
    });

    it('accepts valid return arrow modes', () => {
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-returns': 'all' })).returns, 'all');
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-returns': 'errors' })).returns, 'errors');
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-returns': 'none' })).returns, 'none');
      assert.equal(readSequenceSettings(makeOptions({ sequenceReturns: 'errors' })).returns, 'errors');
      assert.equal(readSequenceSettings(makeOptions({ sequenceReturns: 'none' })).returns, 'none');
    });

    it('falls back to default all on invalid or malformed inputs', () => {
      const bad = ['', 'ALL', 'ERRORS', 'nonee', '  all  ', 'false', '0', 'null'];
      for (const val of bad) {
        assert.equal(
          readSequenceSettings(makeOptions({}, { 'sequence-returns': val })).returns,
          'all',
          `attribute sequence-returns="${val}" must fall back to all`
        );
      }
    });

    it('properly filters return arrows in step projection', () => {
      const index = buildSpanIndex(
        trace(
          [
            'gw',
            [
              span('root', undefined, 0, 100, { name: 'entry', kind: SpanKind.Server }),
              span('c-ok', 'root', 10, 40, { name: 'call-ok', kind: SpanKind.Client }),
              span('c-err', 'root', 50, 90, { name: 'call-err', kind: SpanKind.Client }),
            ],
          ],
          [
            'svc',
            [
              span('s-ok', 'c-ok', 15, 35, { name: 'ok-op', kind: SpanKind.Server, status: { code: 1 } }),
              span('s-err', 'c-err', 55, 85, { name: 'err-op', kind: SpanKind.Server, status: { code: 2 } }),
            ],
          ]
        )
      );
      const model = buildSequenceModel(index);

      // all: returns for root, s-ok, s-err (3 returns)
      const allSteps = projectSteps(model, null, null, null, { returns: 'all' });
      const allReturns = Array.from({ length: allSteps.count }, (_, i) => i).filter((i) => allSteps.kind[i] === StepKind.Return);
      assert.equal(allReturns.length, 3);

      // errors: return only for s-err (status code 2)
      const errSteps = projectSteps(model, null, null, null, { returns: 'errors' });
      const errReturns = Array.from({ length: errSteps.count }, (_, i) => i).filter((i) => errSteps.kind[i] === StepKind.Return);
      assert.equal(errReturns.length, 1);
      assert.equal(errSteps.row[errReturns[0]], index.spans.get('s-err')?.idx);

      // none: zero returns
      const noneSteps = projectSteps(model, null, null, null, { returns: 'none' });
      const noneReturns = Array.from({ length: noneSteps.count }, (_, i) => i).filter((i) => noneSteps.kind[i] === StepKind.Return);
      assert.equal(noneReturns.length, 0);
    });
  });

  describe('sequence-fold option', () => {
    it('defaults to 3 when unconfigured', () => {
      assert.equal(readSequenceSettings(makeOptions()).foldMin, 3);
    });

    it('handles boundary and degenerate values', () => {
      // 0 disables folding
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 0 })).foldMin, 0);
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': '0' })).foldMin, 0);

      // 1 clamps to 2 (minimum viable loop)
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 1 })).foldMin, 2);
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': '1' })).foldMin, 2);

      // negatives clamp to 0 (disabled)
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: -1 })).foldMin, 0);
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: -100 })).foldMin, 0);
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': '-5' })).foldMin, 0);

      // floats floor
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 0.8 })).foldMin, 0);
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 1.9 })).foldMin, 2);
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 2.7 })).foldMin, 2);
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: 4.9 })).foldMin, 4);

      // whitespace trimmed
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': '  5  ' })).foldMin, 5);

      // invalids fall back to default 3
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': '' })).foldMin, 3);
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': 'NaN' })).foldMin, 3);
      assert.equal(readSequenceSettings(makeOptions({}, { 'sequence-fold': 'Infinity' })).foldMin, 3);
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: Number.NaN })).foldMin, 3);
      assert.equal(readSequenceSettings(makeOptions({ sequenceFold: Infinity })).foldMin, 3);
    });

    it('correctly folds repeated calls according to foldMin threshold', () => {
      const index = buildSpanIndex(
        trace([
          'api',
          [
            span('root', undefined, 0, 100, { name: 'list', kind: SpanKind.Server }),
            span('q1', 'root', 10, 15, { name: 'SELECT item', kind: SpanKind.Client, attributes: [{ key: 'db.system', value: { stringValue: 'postgres' } }] }),
            span('q2', 'root', 20, 25, { name: 'SELECT item', kind: SpanKind.Client, attributes: [{ key: 'db.system', value: { stringValue: 'postgres' } }] }),
            span('q3', 'root', 30, 35, { name: 'SELECT item', kind: SpanKind.Client, attributes: [{ key: 'db.system', value: { stringValue: 'postgres' } }] }),
          ],
        ])
      );
      const model = buildSequenceModel(index);

      // foldMin = 0 -> no folding (3 separate calls + root)
      const stepsFold0 = projectSteps(model, null, null, null, { foldMin: 0 });
      const folds0 = Array.from({ length: stepsFold0.count }, (_, i) => i).filter((i) => stepsFold0.kind[i] === StepKind.Fold);
      assert.equal(folds0.length, 0);

      // foldMin = 2 -> folded (run length 3 >= 2)
      const stepsFold2 = projectSteps(model, null, null, null, { foldMin: 2 });
      const folds2 = Array.from({ length: stepsFold2.count }, (_, i) => i).filter((i) => stepsFold2.kind[i] === StepKind.Fold);
      assert.equal(folds2.length, 1);
      assert.equal(stepsFold2.foldCount[folds2[0]], 3);

      // foldMin = 3 -> folded (run length 3 >= 3)
      const stepsFold3 = projectSteps(model, null, null, null, { foldMin: 3 });
      const folds3 = Array.from({ length: stepsFold3.count }, (_, i) => i).filter((i) => stepsFold3.kind[i] === StepKind.Fold);
      assert.equal(folds3.length, 1);

      // foldMin = 4 -> NOT folded (run length 3 < 4)
      const stepsFold4 = projectSteps(model, null, null, null, { foldMin: 4 });
      const folds4 = Array.from({ length: stepsFold4.count }, (_, i) => i).filter((i) => stepsFold4.kind[i] === StepKind.Fold);
      assert.equal(folds4.length, 0);
    });
  });

  describe('row-height option', () => {
    it('defaults to 28 when unconfigured', () => {
      assert.equal(readSequenceSettings(makeOptions()).rowHeight, ROW_H_DEFAULT);
      assert.equal(ROW_H_DEFAULT, 28);
    });

    it('clamps to [18, 48]', () => {
      // lower boundary clamping
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: -20 })).rowHeight, ROW_H_MIN);
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 0 })).rowHeight, ROW_H_MIN);
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 10 })).rowHeight, ROW_H_MIN);
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 17 })).rowHeight, ROW_H_MIN);
      assert.equal(readSequenceSettings(makeOptions({}, { 'row-height': '17' })).rowHeight, ROW_H_MIN);

      // exact boundaries
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 18 })).rowHeight, 18);
      assert.equal(readSequenceSettings(makeOptions({}, { 'row-height': '18' })).rowHeight, 18);
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 48 })).rowHeight, 48);
      assert.equal(readSequenceSettings(makeOptions({}, { 'row-height': '48' })).rowHeight, 48);

      // upper boundary clamping
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 49 })).rowHeight, ROW_H_MAX);
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 100 })).rowHeight, ROW_H_MAX);
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 1000 })).rowHeight, ROW_H_MAX);
      assert.equal(readSequenceSettings(makeOptions({}, { 'row-height': '60' })).rowHeight, ROW_H_MAX);

      // interior values
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 25 })).rowHeight, 25);
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: 32 })).rowHeight, 32);

      // invalids fall back to default
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: Number.NaN })).rowHeight, ROW_H_DEFAULT);
      assert.equal(readSequenceSettings(makeOptions({ rowHeight: Infinity })).rowHeight, ROW_H_DEFAULT);
      assert.equal(readSequenceSettings(makeOptions({}, { 'row-height': '' })).rowHeight, ROW_H_DEFAULT);
      assert.equal(readSequenceSettings(makeOptions({}, { 'row-height': 'xyz' })).rowHeight, ROW_H_DEFAULT);
    });

    it('correctly scales sequence layout geometry with clamped rowHeight', () => {
      const layoutMin = computeSequenceLayout({
        viewWidth: 800,
        viewHeight: 600,
        columnCount: 3,
        rowCount: 10,
        rowHeight: 10, // clamps to 18
      });
      assert.equal(layoutMin.rowHeight, ROW_H_MIN);
      assert.equal(layoutMin.bodyHeight, 10 * ROW_H_MIN + 2 * CANVAS_PAD_Y);
      assert.equal(stepRowY(layoutMin, 5).centerY, CANVAS_PAD_Y + 5 * ROW_H_MIN + ROW_H_MIN / 2);
      assert.equal(stepAtBodyY(layoutMin, CANVAS_PAD_Y + 5 * ROW_H_MIN + 2), 5);

      const layoutMax = computeSequenceLayout({
        viewWidth: 800,
        viewHeight: 600,
        columnCount: 3,
        rowCount: 10,
        rowHeight: 80, // clamps to 48
      });
      assert.equal(layoutMax.rowHeight, ROW_H_MAX);
      assert.equal(layoutMax.bodyHeight, 10 * ROW_H_MAX + 2 * CANVAS_PAD_Y);
      assert.equal(stepRowY(layoutMax, 5).centerY, CANVAS_PAD_Y + 5 * ROW_H_MAX + ROW_H_MAX / 2);
      assert.equal(stepAtBodyY(layoutMax, CANVAS_PAD_Y + 5 * ROW_H_MAX + 2), 5);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2: Trace visualizer events
// ─────────────────────────────────────────────────────────────────────────────

describe('Adversarial Probe 2: Trace Visualizer Events', () => {
  it('trace-loaded event contract: contains spans, roots, and traceId', () => {
    const index = buildSpanIndex(
      trace([
        'svc-test',
        [
          span('s1', undefined, 0, 100, { name: 'root', kind: SpanKind.Server }),
          span('s2', 's1', 10, 50, { name: 'child', kind: SpanKind.Internal }),
        ],
      ])
    );

    const detail = { spans: index.size, roots: index.roots.length, traceId: index.traceId };
    assert.equal(typeof detail.spans, 'number');
    assert.equal(typeof detail.roots, 'number');
    assert.equal(typeof detail.traceId, 'string');
    assert.equal(detail.spans, 2);
    assert.equal(detail.roots, 1);
    assert.equal(detail.traceId.length > 0, true);
  });

  it('trace-loaded payload handles empty and multi-root traces', () => {
    const emptyIndex = createTraceStore().state.data.index;
    const emptyDetail = { spans: emptyIndex.size, roots: emptyIndex.roots.length, traceId: emptyIndex.traceId };
    assert.equal(emptyDetail.spans, 0);
    assert.equal(emptyDetail.roots, 0);

    const multiIndex = buildSpanIndex(
      trace(
        ['svc-1', [span('r1', undefined, 0, 50, { name: 'root1', kind: SpanKind.Server })]],
        ['svc-2', [span('r2', undefined, 10, 60, { name: 'root2', kind: SpanKind.Server })]]
      )
    );
    const multiDetail = { spans: multiIndex.size, roots: multiIndex.roots.length, traceId: multiIndex.traceId };
    assert.equal(multiDetail.spans, 2);
    assert.equal(multiDetail.roots, 2);
  });

  it('span-selected event contract: contains span, spanId, spanIds, and view', () => {
    const index = buildSpanIndex(
      trace([
        'svc-test',
        [
          span('span-alpha', undefined, 0, 100, { name: 'OperationAlpha', kind: SpanKind.Server }),
          span('span-beta', 'span-alpha', 10, 50, { name: 'OperationBeta', kind: SpanKind.Client }),
        ],
      ])
    );

    const primaryId = 'span-alpha';
    const indexed = index.spans.get(primaryId);
    assert.ok(indexed !== undefined);

    const activeView = 'sequence';
    const detail = {
      span: indexed.span,
      spanId: primaryId,
      spanIds: ['span-alpha', 'span-beta'],
      view: activeView,
    };

    assert.equal(detail.spanId, 'span-alpha');
    assert.deepEqual(detail.spanIds, ['span-alpha', 'span-beta']);
    assert.equal(detail.view, 'sequence');
    assert.equal(detail.span.name, 'OperationAlpha');
    assert.equal(typeof detail.span.startTimeUnixNano, 'string');
    assert.equal(typeof detail.span.endTimeUnixNano, 'string');
    assert.equal(typeof indexed.startMs, 'number');
    assert.equal(typeof indexed.endMs, 'number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3: HTML validity across demo/guide.html and demo/demo.html
// ─────────────────────────────────────────────────────────────────────────────

describe('Adversarial Probe 3: HTML Validity Across demo/guide.html and demo/demo.html', () => {
  function auditHtmlStructure(fileName: string) {
    const filePath = resolve(ROOT, 'demo', fileName);
    assert.ok(existsSync(filePath), `file ${filePath} must exist`);
    const content = readFileSync(filePath, 'utf-8');

    // 1. DOCTYPE and essential tags
    assert.match(content, /<!DOCTYPE\s+html>/i, `${fileName} must have valid DOCTYPE`);
    assert.match(content, /<html\b[^>]*>/i, `${fileName} must have opening <html> tag`);
    assert.match(content, /<\/html>/i, `${fileName} must have closing </html> tag`);
    assert.match(content, /<head\b[^>]*>/i, `${fileName} must have <head> tag`);
    assert.match(content, /<\/head>/i, `${fileName} must have </head> tag`);
    assert.match(content, /<body\b[^>]*>/i, `${fileName} must have <body> tag`);
    assert.match(content, /<\/body>/i, `${fileName} must have </body> tag`);

    // 2. DOM ID uniqueness (excluding content inside code blocks)
    // Strip <pre><code> blocks and inline <code> blocks to test only real DOM IDs
    const contentWithoutCode = content
      .replace(/<pre[\s\S]*?<\/pre>/gi, (m) => ' '.repeat(m.length))
      .replace(/<code[\s\S]*?<\/code>/gi, (m) => ' '.repeat(m.length));

    const idRegex = /\bid=["']([^"']+)["']/g;
    const ids = new Map<string, number>();
    let m;
    while ((m = idRegex.exec(contentWithoutCode)) !== null) {
      const id = m[1];
      ids.set(id, (ids.get(id) || 0) + 1);
    }

    const duplicates = [...ids.entries()].filter(([_, count]) => count > 1).map(([id]) => id);
    assert.deepEqual(duplicates, [], `${fileName} must not have duplicate DOM element IDs`);

    // 3. Anchor links validity
    const anchorRegex = /<a\s+[^>]*href=["']#([^"']+)["']/gi;
    const brokenAnchors: string[] = [];
    while ((m = anchorRegex.exec(content)) !== null) {
      const hash = m[1];
      if (!ids.has(hash)) {
        brokenAnchors.push(hash);
      }
    }
    assert.deepEqual(brokenAnchors, [], `${fileName} must not have broken internal anchor links`);

    // 4. Local relative references exist on disk (excluding virtual docs/dist mapped by server)
    const relFileRegex = /\b(?:href|src)=["'](\.[^"'#?]+)(?:[?#][^"']*)?["']/gi;
    const dir = dirname(filePath);
    const brokenRefs: string[] = [];
    while ((m = relFileRegex.exec(contentWithoutCode)) !== null) {
      const rel = m[1];
      // server.js maps /dist and /docs to parent dir
      const resolved = (rel.startsWith('./dist/') || rel.startsWith('./docs/'))
        ? resolve(ROOT, rel.replace(/^\.\//, ''))
        : resolve(dir, rel);
      if (!existsSync(resolved)) {
        brokenRefs.push(`${rel} -> ${resolved}`);
      }
    }
    assert.deepEqual(brokenRefs, [], `${fileName} must not have broken local relative file references`);

    // 5. Script syntax validation
    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let sMatch;
    let sIdx = 0;
    while ((sMatch = scriptRegex.exec(content)) !== null) {
      sIdx++;
      const code = sMatch[2].trim();
      if (!code) continue;
      const isModule = sMatch[1].includes('type="module"') || sMatch[1].includes("type='module'");
      const transpiled = ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: isModule ? ts.ModuleKind.ESNext : ts.ModuleKind.None,
        },
        reportDiagnostics: true,
      });
      assert.deepEqual(
        transpiled.diagnostics ?? [],
        [],
        `${fileName} script #${sIdx} has syntax or transpile diagnostics`
      );
    }
  }

  it('demo/demo.html satisfies HTML validity, unique IDs, intact links, and valid scripts', () => {
    auditHtmlStructure('demo.html');
  });

  it('demo/guide.html satisfies HTML validity, unique IDs, intact links, and valid scripts', () => {
    auditHtmlStructure('guide.html');
  });
});
