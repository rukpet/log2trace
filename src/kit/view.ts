/**
 * Kit: the contract of a view
 *
 * A view is one way of drawing the loaded trace: the waterfall today, a flame graph, a service
 * graph or a sequence diagram tomorrow. The element hosts exactly one at a time in a surface it
 * hands over, and everything it needs of a view is in {@link TraceView}; the shell (toolbar,
 * tooltip, detail panel, tabs) needs even less and never imports a view.
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
  /** The id used in the `view` and `views` attributes. */
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

/**
 * The ids to show as tabs, from the value of the `views` attribute: the registered ones, once each,
 * in the order given. An empty or unusable list falls back to the first registered view.
 */
export function parseViewIds(value: string | null, known: readonly string[]): string[] {
  const asked = (value ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '');
  const ids = [...new Set(asked)].filter((id) => known.includes(id));
  return ids.length > 0 ? ids : known.slice(0, 1);
}
