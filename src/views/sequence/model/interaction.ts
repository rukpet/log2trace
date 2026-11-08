/**
 * Sequence diagram headless interaction reducer.
 *
 * Maps normalized pointer, wheel, keyboard, and resize inputs against the current
 * `SequenceViewState`, `SequenceSteps`, and `SequenceLayout` to produce the next
 * view state, dirty flags for the painter, and store/scroll side-effects.
 *
 * Headless: no DOM, no browser globals.
 */

import type { SpanId } from '../../../core.ts';
import {
  DEFAULT_SEQUENCE_SETTINGS,
  type InternalSpanMode,
  type ReturnArrowMode,
  type SequenceSettings,
} from '../settings.ts';
import { spansOfActivation, spansOfParticipant, spansOfStep } from './describe.ts';
import { HitKind, type SequenceHit } from './hit.ts';
import {
  CANVAS_PAD_Y,
  ROW_H_MAX,
  ROW_H_MIN,
  computeSequenceLayout,
  stepRowY,
  type SequenceLayout,
} from './layout.ts';
import { StepFlag, StepKind, type SequenceSteps } from './steps.ts';

/** Dirty bits telling the painter what changed. */
export const enum SequenceDirty {
  None = 0,
  Layout = 1,
  Columns = 2,
  Rows = 4,
  Scroll = 8,
  Overlay = 16,
  Theme = 32,
  All = 63,
}

/** View-local state of the sequence diagram (persisted across tab switches via getState/setState). */
export interface SequenceViewState {
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly rowHeight: number;
  readonly fitColumns: boolean;
  readonly internal: InternalSpanMode;
  readonly returns: ReturnArrowMode;
  readonly foldMin: number;
  readonly matchesOnly: boolean;
  readonly hideUnaffectedColumns: boolean;
  readonly expandedFolds: ReadonlySet<string>;
  readonly focusStep: number;
}

/** Store/view side-effects emitted by the interaction reducer. */
export type SequenceEffect =
  | { readonly type: 'select'; readonly ids: readonly SpanId[]; readonly primary: SpanId | null; readonly key: string }
  | {
      readonly type: 'hover';
      readonly ids: readonly SpanId[] | null;
      readonly primary?: SpanId | null;
      readonly key?: string;
      readonly hit: SequenceHit | null;
    }
  | { readonly type: 'toggle-collapse'; readonly id: SpanId }
  | { readonly type: 'scroll-to'; readonly scrollTop: number; readonly scrollLeft?: number };

/** Normalized input actions fed to `reduceSequenceInteraction`. */
export type SequenceInput =
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | { readonly type: 'scroll'; readonly scrollTop: number; readonly scrollLeft: number }
  | { readonly type: 'pan'; readonly dx: number; readonly dy: number }
  | { readonly type: 'zoom-density'; readonly factor: number; readonly anchorY: number }
  | { readonly type: 'click'; readonly hit: SequenceHit }
  | { readonly type: 'dblclick'; readonly hit: SequenceHit }
  | { readonly type: 'hover'; readonly hit: SequenceHit }
  | { readonly type: 'leave' }
  | { readonly type: 'key'; readonly key: string; readonly shiftKey?: boolean };

export interface SequenceTransition {
  readonly state: SequenceViewState;
  readonly dirty: number;
  readonly effects: readonly SequenceEffect[];
  readonly handled: boolean;
}

const NO_EFFECTS: readonly SequenceEffect[] = Object.freeze([]);

/** Create the initial `SequenceViewState` from optional sequence settings. */
export function createInitialSequenceViewState(
  settings: Partial<SequenceSettings> = {},
): SequenceViewState {
  const rawRowHeight = settings.rowHeight ?? DEFAULT_SEQUENCE_SETTINGS.rowHeight;
  const rowHeight = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, rawRowHeight));
  return {
    viewWidth: 0,
    viewHeight: 0,
    scrollTop: 0,
    scrollLeft: 0,
    rowHeight,
    fitColumns: false,
    internal: settings.internal ?? DEFAULT_SEQUENCE_SETTINGS.internal,
    returns: settings.returns ?? DEFAULT_SEQUENCE_SETTINGS.returns,
    foldMin: settings.foldMin ?? DEFAULT_SEQUENCE_SETTINGS.foldMin,
    matchesOnly: false,
    hideUnaffectedColumns: false,
    expandedFolds: new Set<string>(),
    focusStep: -1,
  };
}

/** Clamp `scrollTop` into the valid scrollable vertical range for `layout`. */
export function clampSequenceScrollTop(layout: SequenceLayout, scrollTop: number): number {
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return 0;
  if (layout.rowCount <= 0) return 0;
  if (layout.bodyViewportHeight <= 0) return scrollTop;
  const maxTop = Math.max(0, layout.bodyHeight - layout.bodyViewportHeight);
  return Math.min(scrollTop, maxTop);
}

/** Clamp `scrollLeft` into the valid scrollable horizontal range for `layout`. */
export function clampSequenceScrollLeft(layout: SequenceLayout, scrollLeft: number): number {
  if (!Number.isFinite(scrollLeft) || scrollLeft <= 0) return 0;
  if (layout.columnCount <= 0) return 0;
  if (layout.viewWidth <= 0) return scrollLeft;
  const maxLeft = Math.max(0, layout.contentWidth - layout.viewWidth);
  return Math.min(scrollLeft, maxLeft);
}

/** Compute the `scrollTop` needed to reveal `step` within `layout`. */
export function revealStepScrollTop(
  layout: SequenceLayout,
  scrollTop: number,
  step: number,
): number {
  if (step < 0 || step >= layout.rowCount || layout.rowCount <= 0) {
    return clampSequenceScrollTop(layout, scrollTop);
  }
  const { top, bottom } = stepRowY(layout, step);
  if (layout.bodyViewportHeight <= 0) {
    return step === 0 ? 0 : top;
  }
  const current = clampSequenceScrollTop(layout, scrollTop);
  if (top < current) {
    return clampSequenceScrollTop(layout, step === 0 ? 0 : top);
  }
  if (bottom > current + layout.bodyViewportHeight) {
    return clampSequenceScrollTop(layout, Math.min(top, bottom - layout.bodyViewportHeight));
  }
  return current;
}

function toggleFoldInSet(folds: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(folds);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

function selectAndRevealStep(
  state: SequenceViewState,
  steps: SequenceSteps,
  layout: SequenceLayout,
  targetStep: number,
): SequenceTransition {
  if (steps.count <= 0 || targetStep < 0 || targetStep >= steps.count) {
    return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
  }
  const sel = spansOfStep(steps, targetStep);
  const scrollTop = revealStepScrollTop(layout, state.scrollTop, targetStep);
  const scrolled = scrollTop !== state.scrollTop;
  const nextState: SequenceViewState = {
    ...state,
    focusStep: targetStep,
    scrollTop,
  };
  const effects: SequenceEffect[] = [
    { type: 'select', ids: sel.ids, primary: sel.primary, key: sel.key },
  ];
  if (scrolled) {
    effects.push({ type: 'scroll-to', scrollTop });
  }
  const dirty = SequenceDirty.Overlay | (scrolled ? SequenceDirty.Scroll : SequenceDirty.None);
  return {
    state: nextState,
    dirty,
    effects,
    handled: true,
  };
}

function handleClick(
  state: SequenceViewState,
  hit: SequenceHit,
  steps: SequenceSteps,
): SequenceTransition {
  const { table } = steps.model.index;
  switch (hit.kind) {
    case HitKind.Participant: {
      const sel = spansOfParticipant(steps.model, hit.index);
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'select', ids: sel.ids, primary: sel.primary, key: sel.key }],
        handled: true,
      };
    }
    case HitKind.Step:
    case HitKind.Fold: {
      const sel = spansOfStep(steps, hit.index);
      const nextState =
        hit.index >= 0 && hit.index < steps.count
          ? { ...state, focusStep: hit.index }
          : state;
      return {
        state: nextState,
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'select', ids: sel.ids, primary: sel.primary, key: sel.key }],
        handled: true,
      };
    }
    case HitKind.Activation: {
      const sel = spansOfActivation(steps, hit.index);
      const focusStep =
        hit.index >= 0 && hit.index < steps.act.count
          ? steps.act.startStep[hit.index]
          : state.focusStep;
      return {
        state: { ...state, focusStep },
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'select', ids: sel.ids, primary: sel.primary, key: sel.key }],
        handled: true,
      };
    }
    case HitKind.EventTick: {
      if (hit.row >= 0 && hit.row < table.length) {
        const id = table.ids[hit.row];
        return {
          state,
          dirty: SequenceDirty.Overlay,
          effects: [{ type: 'select', ids: [id], primary: id, key: `ev:${hit.row}:${hit.eventIdx}` }],
          handled: true,
        };
      }
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'select', ids: [], primary: null, key: '' }],
        handled: true,
      };
    }
    case HitKind.None:
    default:
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'select', ids: [], primary: null, key: '' }],
        handled: true,
      };
  }
}

function handleDblClick(
  state: SequenceViewState,
  hit: SequenceHit,
  steps: SequenceSteps,
): SequenceTransition {
  const { table } = steps.model.index;
  if (
    hit.kind === HitKind.Fold ||
    (hit.kind === HitKind.Step &&
      hit.index >= 0 &&
      hit.index < steps.count &&
      steps.kind[hit.index] === StepKind.Fold)
  ) {
    const foldRow =
      hit.index >= 0 && hit.index < steps.count ? steps.row[hit.index] : hit.row;
    if (foldRow >= 0) {
      const nextFolds = toggleFoldInSet(state.expandedFolds, `fold:${foldRow}`);
      return {
        state: { ...state, expandedFolds: nextFolds },
        dirty: SequenceDirty.Rows,
        effects: NO_EFFECTS,
        handled: true,
      };
    }
    return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: false };
  }

  if (hit.kind === HitKind.Step || hit.kind === HitKind.Activation) {
    let row = hit.row;
    if (row < 0) {
      if (hit.kind === HitKind.Step && hit.index >= 0 && hit.index < steps.count) {
        row = steps.row[hit.index];
      } else if (hit.kind === HitKind.Activation && hit.index >= 0 && hit.index < steps.act.count) {
        row = steps.act.row[hit.index];
      }
    }
    if (row >= 0 && row < table.length && table.subtreeEnd[row] > row + 1) {
      return {
        state,
        dirty: SequenceDirty.None,
        effects: [{ type: 'toggle-collapse', id: table.ids[row] }],
        handled: true,
      };
    }
  }

  return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: false };
}

function handleHover(
  state: SequenceViewState,
  hit: SequenceHit,
  steps: SequenceSteps,
): SequenceTransition {
  const { table } = steps.model.index;
  switch (hit.kind) {
    case HitKind.Participant: {
      const target = spansOfParticipant(steps.model, hit.index);
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [
          {
            type: 'hover',
            ids: target.ids,
            primary: target.primary,
            key: target.key,
            hit,
          },
        ],
        handled: true,
      };
    }
    case HitKind.Step:
    case HitKind.Fold: {
      const target = spansOfStep(steps, hit.index);
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [
          {
            type: 'hover',
            ids: target.ids,
            primary: target.primary,
            key: target.key,
            hit,
          },
        ],
        handled: true,
      };
    }
    case HitKind.Activation: {
      const target = spansOfActivation(steps, hit.index);
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [
          {
            type: 'hover',
            ids: target.ids,
            primary: target.primary,
            key: target.key,
            hit,
          },
        ],
        handled: true,
      };
    }
    case HitKind.EventTick: {
      if (hit.row >= 0 && hit.row < table.length) {
        const id = table.ids[hit.row];
        return {
          state,
          dirty: SequenceDirty.Overlay,
          effects: [
            {
              type: 'hover',
              ids: [id],
              primary: id,
              key: `ev:${hit.row}:${hit.eventIdx}`,
              hit,
            },
          ],
          handled: true,
        };
      }
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'hover', ids: null, primary: null, key: '', hit: null }],
        handled: true,
      };
    }
    case HitKind.None:
    default:
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'hover', ids: null, primary: null, key: '', hit: null }],
        handled: true,
      };
  }
}

function handleKey(
  state: SequenceViewState,
  input: Extract<SequenceInput, { type: 'key' }>,
  steps: SequenceSteps,
  layout: SequenceLayout,
): SequenceTransition {
  const { table } = steps.model.index;
  const focus = state.focusStep;

  switch (input.key) {
    case 'ArrowDown': {
      if (steps.count <= 0) {
        return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
      }
      const nextStep = focus < 0 ? 0 : Math.min(steps.count - 1, focus + 1);
      return selectAndRevealStep(state, steps, layout, nextStep);
    }
    case 'ArrowUp': {
      if (steps.count <= 0) {
        return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
      }
      const nextStep = focus < 0 ? 0 : Math.max(0, focus - 1);
      return selectAndRevealStep(state, steps, layout, nextStep);
    }
    case 'ArrowRight': {
      if (focus >= 0 && focus < steps.count) {
        if (focus + 1 < steps.count && steps.depth[focus + 1] > steps.depth[focus]) {
          return selectAndRevealStep(state, steps, layout, focus + 1);
        }
        if (steps.kind[focus] === StepKind.Fold) {
          const foldRow = steps.row[focus];
          const nextFolds = new Set(state.expandedFolds);
          nextFolds.add(`fold:${foldRow}`);
          return {
            state: { ...state, expandedFolds: nextFolds },
            dirty: SequenceDirty.Rows,
            effects: NO_EFFECTS,
            handled: true,
          };
        }
        const actIdx = steps.actIndex[focus];
        const row = steps.row[focus];
        const isCollapsed =
          (actIdx >= 0 && steps.act.collapsed[actIdx] === 1) ||
          (row >= 0 && row < table.length && table.subtreeEnd[row] > row + 1);
        if (
          isCollapsed &&
          row >= 0 &&
          row < table.length &&
          table.subtreeEnd[row] > row + 1 &&
          (actIdx < 0 || steps.act.collapsed[actIdx] === 1)
        ) {
          return {
            state,
            dirty: SequenceDirty.None,
            effects: [{ type: 'toggle-collapse', id: table.ids[row] }],
            handled: true,
          };
        }
      }
      return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
    }
    case 'ArrowLeft': {
      if (focus >= 0 && focus < steps.count) {
        const actIdx = steps.act.innermostAtStep[focus];
        if (actIdx >= 0 && actIdx < steps.act.count) {
          if (steps.act.startStep[actIdx] < focus) {
            return selectAndRevealStep(state, steps, layout, steps.act.startStep[actIdx]);
          }
          const parentAct = steps.act.parent[actIdx];
          if (parentAct >= 0 && parentAct < steps.act.count) {
            return selectAndRevealStep(state, steps, layout, steps.act.startStep[parentAct]);
          }
        }
      }
      return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
    }
    case 'r':
    case 'R': {
      if (focus >= 0 && focus < steps.count && steps.pair[focus] >= 0) {
        return selectAndRevealStep(state, steps, layout, steps.pair[focus]);
      }
      return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
    }
    case 'e':
    case 'E': {
      if (steps.count <= 0) {
        return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
      }
      const reverse = Boolean(input.shiftKey);
      if (!reverse) {
        const startIdx = focus >= 0 && focus < steps.count ? focus : -1;
        for (let offset = 1; offset <= steps.count; offset++) {
          const s = (startIdx + offset) % steps.count;
          if ((steps.flags[s] & StepFlag.Error) !== 0) {
            return selectAndRevealStep(state, steps, layout, s);
          }
        }
      } else {
        const startIdx = focus >= 0 && focus < steps.count ? focus : 0;
        for (let offset = 1; offset <= steps.count; offset++) {
          const s = (startIdx - offset + steps.count) % steps.count;
          if ((steps.flags[s] & StepFlag.Error) !== 0) {
            return selectAndRevealStep(state, steps, layout, s);
          }
        }
      }
      return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
    }
    case 'Home': {
      if (steps.count <= 0) {
        return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
      }
      return selectAndRevealStep(state, steps, layout, 0);
    }
    case 'End': {
      if (steps.count <= 0) {
        return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
      }
      return selectAndRevealStep(state, steps, layout, steps.count - 1);
    }
    case 'PageDown':
    case 'PageUp': {
      if (steps.count <= 0) {
        return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
      }
      const pageJump = Math.max(1, Math.floor(layout.bodyViewportHeight / layout.rowHeight) - 1);
      const base = focus < 0 ? 0 : focus;
      const nextStep =
        input.key === 'PageDown'
          ? Math.min(steps.count - 1, base + pageJump)
          : Math.max(0, base - pageJump);
      return selectAndRevealStep(state, steps, layout, nextStep);
    }
    case 'Enter': {
      if (focus >= 0 && focus < steps.count) {
        if (steps.kind[focus] === StepKind.Fold) {
          const foldRow = steps.row[focus];
          const nextFolds = toggleFoldInSet(state.expandedFolds, `fold:${foldRow}`);
          return {
            state: { ...state, expandedFolds: nextFolds },
            dirty: SequenceDirty.Rows,
            effects: NO_EFFECTS,
            handled: true,
          };
        }
        const row = steps.row[focus];
        if (row >= 0 && row < table.length && table.subtreeEnd[row] > row + 1) {
          return {
            state,
            dirty: SequenceDirty.None,
            effects: [{ type: 'toggle-collapse', id: table.ids[row] }],
            handled: true,
          };
        }
      }
      return { state, dirty: SequenceDirty.None, effects: NO_EFFECTS, handled: true };
    }
    case 'i':
    case 'I': {
      const nextInternal: InternalSpanMode =
        state.internal === 'auto' ? 'show' : state.internal === 'show' ? 'hide' : 'auto';
      return {
        state: { ...state, internal: nextInternal },
        dirty: SequenceDirty.Rows,
        effects: NO_EFFECTS,
        handled: true,
      };
    }
    case 'Escape': {
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'select', ids: [], primary: null, key: '' }],
        handled: true,
      };
    }
    default:
      return {
        state,
        dirty: SequenceDirty.None,
        effects: NO_EFFECTS,
        handled: false,
      };
  }
}

/**
 * Pure interaction reducer for the sequence diagram.
 */
export function reduceSequenceInteraction(
  state: SequenceViewState,
  input: SequenceInput,
  steps: SequenceSteps,
  layout: SequenceLayout,
): SequenceTransition {
  switch (input.type) {
    case 'resize': {
      const nextLayout = computeSequenceLayout({
        viewWidth: input.width,
        viewHeight: input.height,
        columnCount: layout.columnCount,
        rowCount: steps.count,
        rowHeight: state.rowHeight,
        fitColumns: state.fitColumns,
        gutterWidth: layout.gutterWidth,
      });
      const scrollTop = clampSequenceScrollTop(nextLayout, state.scrollTop);
      const scrollLeft = clampSequenceScrollLeft(nextLayout, state.scrollLeft);
      return {
        state: {
          ...state,
          viewWidth: nextLayout.viewWidth,
          viewHeight: nextLayout.viewHeight,
          scrollTop,
          scrollLeft,
        },
        dirty: SequenceDirty.Layout | SequenceDirty.Rows,
        effects: NO_EFFECTS,
        handled: true,
      };
    }
    case 'scroll': {
      const scrollTop = clampSequenceScrollTop(layout, input.scrollTop);
      const scrollLeft = clampSequenceScrollLeft(layout, input.scrollLeft);
      return {
        state: {
          ...state,
          scrollTop,
          scrollLeft,
        },
        dirty: SequenceDirty.Scroll,
        effects: NO_EFFECTS,
        handled: true,
      };
    }
    case 'pan': {
      const scrollTop = clampSequenceScrollTop(layout, state.scrollTop - input.dy);
      const scrollLeft = clampSequenceScrollLeft(layout, state.scrollLeft - input.dx);
      return {
        state: {
          ...state,
          scrollTop,
          scrollLeft,
        },
        dirty: SequenceDirty.Scroll,
        effects: [{ type: 'scroll-to', scrollTop, scrollLeft }],
        handled: true,
      };
    }
    case 'zoom-density': {
      const rowHeight = Math.min(
        ROW_H_MAX,
        Math.max(ROW_H_MIN, Math.round(state.rowHeight * input.factor)),
      );
      const bodyOffsetY =
        input.anchorY >= layout.headerHeight
          ? input.anchorY - layout.headerHeight
          : Math.max(0, input.anchorY);
      const relY = Math.max(0, state.scrollTop + bodyOffsetY - CANVAS_PAD_Y);
      const stepRatio = state.rowHeight > 0 ? relY / state.rowHeight : 0;
      const nextLayout = computeSequenceLayout({
        viewWidth: state.viewWidth,
        viewHeight: state.viewHeight,
        columnCount: layout.columnCount,
        rowCount: steps.count,
        rowHeight,
        fitColumns: state.fitColumns,
        gutterWidth: layout.gutterWidth,
      });
      const rawScrollTop =
        stepRatio > 0 ? CANVAS_PAD_Y + stepRatio * rowHeight - bodyOffsetY : 0;
      const scrollTop = clampSequenceScrollTop(nextLayout, rawScrollTop);
      return {
        state: {
          ...state,
          rowHeight,
          scrollTop,
        },
        dirty: SequenceDirty.Layout | SequenceDirty.Rows,
        effects: [{ type: 'scroll-to', scrollTop }],
        handled: true,
      };
    }
    case 'click':
      return handleClick(state, input.hit, steps);
    case 'dblclick':
      return handleDblClick(state, input.hit, steps);
    case 'hover':
      return handleHover(state, input.hit, steps);
    case 'leave':
      return {
        state,
        dirty: SequenceDirty.Overlay,
        effects: [{ type: 'hover', ids: null, primary: null, key: '', hit: null }],
        handled: true,
      };
    case 'key':
      return handleKey(state, input, steps, layout);
  }
}
