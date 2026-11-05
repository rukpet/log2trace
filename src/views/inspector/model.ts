/**
 * The inspector's model: what the store holds, as text.
 *
 * The inspector is the smallest possible view. It has no time axis, no rows to scroll and no
 * painter; it shows the shared state (data, selection, hover, collapsed spans, filter, time
 * window) as rows of text and the selected spans as a short list. That makes it a test of the
 * view contract: whatever it needs, a flame graph or a service graph needs at most the same.
 *
 * Headless: no DOM, no browser globals.
 */

import { Slice, defineSelector, type Selector, type SpanId, type Target, type TraceState } from '../../core.ts';

/** One line of the state table. */
export interface InspectorRow {
  /** Stable name of the line; the view keeps one element per id. */
  readonly id: 'phase' | 'spans' | 'trace' | 'selection' | 'hover' | 'collapsed' | 'filter' | 'window';
  readonly label: string;
  readonly value: string;
}

/** A selected span in the list. */
export interface InspectorSpan {
  readonly id: SpanId;
  readonly label: string;
}

/** Everything the inspector shows. */
export interface InspectorModel {
  readonly rows: readonly InspectorRow[];
  /** The selected spans, at most {@link MAX_LISTED}. */
  readonly selected: readonly InspectorSpan[];
  /** How many spans are selected in all. */
  readonly selectedTotal: number;
  /** Identifies the list: it changes exactly when the list has to be rebuilt. */
  readonly selectedKey: string;
}

/** The longest list of selected spans the inspector draws. */
export const MAX_LISTED = 20;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function targetText(target: Target | null, state: TraceState): string {
  if (target === null || target.ids.size === 0) return 'none';
  const primary = target.primary === null ? undefined : state.data.index.spans.get(target.primary);
  const name = primary === undefined ? '' : `: ${primary.span.name}`;
  const key = target.key === undefined ? '' : `, element ${target.key}`;
  return `${plural(target.ids.size, 'span')}${name} (from ${target.origin}${key})`;
}

function windowText(state: TraceState): string {
  const { window } = state;
  return window === null ? 'whole trace' : `${window.t0.toFixed(1)} to ${window.t1.toFixed(1)} ms`;
}

/** The inspector's model of a state. */
export function describeState(state: TraceState): InspectorModel {
  const { data, matched } = state;
  const total = data.index.size;

  const selected: InspectorSpan[] = [];
  for (const id of state.selection.ids) {
    if (selected.length === MAX_LISTED) break;
    const indexed = data.index.spans.get(id);
    selected.push({ id, label: indexed === undefined ? id : `${indexed.serviceName}: ${indexed.span.name}` });
  }

  return {
    rows: [
      { id: 'phase', label: 'Data', value: data.phase === 'error' ? `error: ${data.error ?? 'unknown'}` : data.phase },
      { id: 'spans', label: 'Spans', value: `${total} in ${plural(data.index.roots.length, 'tree')}` },
      { id: 'trace', label: 'Trace', value: data.index.traceId || 'none' },
      { id: 'selection', label: 'Selected', value: targetText(state.selection, state) },
      { id: 'hover', label: 'Hovered', value: targetText(state.hover, state) },
      { id: 'collapsed', label: 'Collapsed', value: plural(state.collapsed.size, 'span') },
      { id: 'filter', label: 'Filter', value: matched === null ? 'off' : `${matched.size} of ${total} spans match` },
      { id: 'window', label: 'Time window', value: windowText(state) },
    ],
    selected,
    selectedTotal: state.selection.ids.size,
    selectedKey: `${data.generation}|${selected.map((span) => span.id).join(',')}|${state.selection.ids.size}`,
  };
}

/** The inspector's model, cached until a slice it shows changes. */
export const inspectorModel: Selector<InspectorModel> = defineSelector(
  'inspector.model',
  Slice.Data | Slice.Selection | Slice.Hover | Slice.Collapse | Slice.Filter | Slice.Window,
  (state) => describeState(state),
);
