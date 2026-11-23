/**
 * Kit: the contract of a view
 *
 * A view is one way of drawing the loaded trace: the waterfall, a flame graph, a service graph or
 * a sequence diagram. The element hosts exactly one at a time in a surface it hands over, and
 * everything it needs of a view is in {@link TraceView}; the shell (toolbar, tooltip, detail panel,
 * tabs) needs even less and never imports a view.
 *
 * What is shared by every view lives in the store: the data, the selection, the hover, the
 * collapsed spans, the filter result and the time window. What is a view's own (the camera, the
 * scroll position) stays in the view and travels between tabs as the opaque value of
 * {@link TraceView.getState} and {@link TraceView.setState}. A view tells the page about a hover
 * by calling {@link ViewContext.hover} with a {@link ViewHit}, and about a selection by writing
 * to the store with its own origin; nothing else is pushed up.
 *
 * Views are registered by id and found again with {@link getView}; a view that is not shown is
 * not mounted and costs nothing.
 */

import type { ChangeSet, InfoModel, SpanId, TraceStore } from '../core.ts';
import type { ViewCommand } from './commands.ts';
import type { RendererKind, ViewOptions } from './view-options.ts';

export type { RendererKind } from './view-options.ts';

/** The element a pointer rests on, as the page needs to describe it. */
export interface ViewHit {
  /** Identifies what is shown, so the content is rebuilt only when it changes. */
  readonly key: string;
  /** The element's box in the coordinates of the view's surface. */
  readonly anchor: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Size of the surface, so the tooltip can stay inside it. */
  readonly bounds: { readonly width: number; readonly height: number };
  /** What to say about it, built only when it is shown. */
  info(): InfoModel | null;
}

/** What the element gives a view when it mounts it. */
export interface ViewContext {
  /** Names this view in the store: the changes it writes carry it, and it ignores their echoes. */
  readonly origin: string;
  readonly store: TraceStore;
  /**
   * The current configuration of the element, read again whenever {@link TraceView.optionsChanged}
   * is called. The view reads the options it knows (see `view-options.ts`) into its own settings.
   */
  options(): ViewOptions;
  /** The pointer is over something (or over nothing, with `null`). */
  hover(hit: ViewHit | null): void;
  /** The commands' readouts or enabled state changed: the toolbar should read them again. */
  refreshCommands(): void;
}

/** A mounted view. */
export interface TraceView {
  /** The backend in use, for a view that has one. */
  readonly renderer?: RendererKind;
  /** Build the view inside `surface`, an element the view may fill and listen on. */
  mount(surface: HTMLElement, ctx: ViewContext): void;
  /** The store changed. Only mark what is dirty; drawing waits for the frame. */
  update(change: ChangeSet): void;
  /** The configuration of the element changed: read {@link ViewContext.options} again. */
  optionsChanged(): void;
  /** A `--l2t-*` token may have changed: read the theme again. */
  themeChanged(): void;
  /** The buttons and keys of the view, for the toolbar. */
  commands(): readonly ViewCommand[];
  /** Bring a span into view (it is already selected, with its ancestors expanded). */
  reveal?(id: SpanId): void;
  /** Put the keyboard focus on the view, for the shell to hand it back after a panel or the filter bar. */
  focus?(): void;
  /** Where the view looks, to restore it when it is shown again. The value is the view's own. */
  getState(): unknown;
  /** Restore what {@link TraceView.getState} returned; called after mount. */
  setState(state: unknown): void;
  /** Remove everything the view added and stop its listeners. */
  unmount(): void;
}

/** What the page can tell about a view without mounting it. */
export interface ViewDefinition {
  /** The id used in `<trace-view type>` and the `view` attribute. */
  readonly id: string;
  /** The text of its tab. */
  readonly label: string;
  /** The backends it draws with, the default first. */
  readonly renderers: readonly RendererKind[];
  readonly capabilities: {
    /** Show the span-kind legend in the toolbar. */
    readonly legend?: boolean;
  };
  create(): TraceView;
}

const registry = new Map<string, ViewDefinition>();

/** Make a view available under its id. Registering an id again replaces it. */
export function registerView(definition: ViewDefinition): void {
  registry.set(definition.id, definition);
}

/** The view registered under an id. */
export function getView(id: string): ViewDefinition | undefined {
  return registry.get(id);
}

/** All registered views, in the order they were registered. */
export function listViews(): readonly ViewDefinition[] {
  return [...registry.values()];
}

/** The backend to use: the one asked for when the view has it, else the view's default. */
export function resolveRenderer(asked: RendererKind | undefined, available: readonly RendererKind[]): RendererKind {
  return asked !== undefined && available.includes(asked) ? asked : available[0];
}

/** One `<trace-view>` child as declared, before it is checked against the registry. */
export interface ViewDeclaration {
  readonly type: string;
  readonly label?: string;
  readonly active: boolean;
}

/** One tab to show. */
export interface ViewTab {
  readonly id: string;
  readonly label: string;
}

/** The view shown when nothing usable is declared. */
export const DEFAULT_VIEW = 'waterfall';

/**
 * The tabs to show and the view to start with. Registered types only, once each (the first
 * declaration of a type wins), in document order; `label` overrides the definition's label.
 * `initial` is the first declaration marked `active`, else the first tab. When nothing usable
 * is declared, falls back to the default view (or the first registered one if absent).
 */
export function resolveViews(
  declared: readonly ViewDeclaration[],
  known: readonly ViewDefinition[],
): { tabs: ViewTab[]; initial: string } {
  const tabs: ViewTab[] = [];
  let initial: string | undefined;
  for (const d of declared) {
    const def = known.find((k) => k.id === d.type);
    if (def === undefined || tabs.some((t) => t.id === def.id)) continue;
    tabs.push({ id: def.id, label: d.label ?? def.label });
    if (d.active && initial === undefined) initial = def.id;
  }
  if (tabs.length === 0) {
    const fallback = known.find((k) => k.id === DEFAULT_VIEW) ?? known[0];
    return fallback === undefined
      ? { tabs: [], initial: '' }
      : { tabs: [{ id: fallback.id, label: fallback.label }], initial: fallback.id };
  }
  return { tabs, initial: initial ?? tabs[0].id };
}
