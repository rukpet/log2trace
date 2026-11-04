/**
 * Kit input: normalisation
 *
 * Pure functions that turn what a wheel or key event says into the plain
 * data of `types.ts`: which gesture a wheel event is (zoom, pan, or left to the
 * browser), by how much, and whether a key is one a view handles. The numbers
 * come from the camera helpers (`normalizeWheelDelta`, `wheelZoomFactor`), so a
 * wheel zooms the same wherever it is used. No DOM types: a plain object with
 * the right fields stands in for the event, which is how the tests run.
 */

import { normalizeWheelDelta, wheelZoomFactor } from '../geometry/camera1d.ts';
import { InputActionKind, Key, type KeyInput, type PanAction, type WheelInput, type ZoomAction } from './types.ts';

/** How to read a wheel event. */
export interface WheelOptions {
  /** Height of one page in px, the unit of a wheel that reports pages: normally the viewport's height. */
  readonly pageSizePx: number;
  /** A plain wheel zooms (the old behaviour) instead of scrolling the content natively. */
  readonly wheelZoom: boolean;
}

/** The `KeyboardEvent` fields {@link normalizeKey} reads; a real event satisfies this as it is. */
export interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
}

const KEYS: ReadonlyMap<string, Key> = new Map([
  ['ArrowUp', Key.ArrowUp],
  ['ArrowDown', Key.ArrowDown],
  ['ArrowLeft', Key.ArrowLeft],
  ['ArrowRight', Key.ArrowRight],
  ['Home', Key.Home],
  ['End', Key.End],
  ['PageUp', Key.PageUp],
  ['PageDown', Key.PageDown],
  ['Enter', Key.Enter],
  [' ', Key.Space],
  ['Escape', Key.Escape],
  ['+', Key.Plus],
  ['=', Key.Plus],
  ['-', Key.Minus],
  ['_', Key.Minus],
  ['0', Key.Zero],
]);

/** The element tags whose own key handling a view must not take over. */
const FORM_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Decide what a wheel event means for a time-axis view:
 *
 * - Ctrl or Meta held (a trackpad pinch arrives as Ctrl+wheel): zoom around the
 *   cursor. The speed is `PINCH_ZOOM_K` with Ctrl and `WHEEL_ZOOM_K` with Meta
 *   alone, `deltaMode` is normalised and |dy| limited, all by `wheelZoomFactor`.
 * - Shift held, or a gesture that is more horizontal than vertical: pan along the
 *   time axis; a vertical-only Shift+wheel pans too, as browsers that do not
 *   translate it expect.
 * - A plain vertical wheel: zoom when `wheelZoom` is on, otherwise `null`, which
 *   means "not ours": the native scroller moves the rows.
 *
 * @param wheel - The event as plain data.
 * @param options - Page size and whether a plain wheel zooms.
 * @returns A zoom or a pan, or `null` when the browser should handle the event.
 */
export function interpretWheel(wheel: WheelInput, options: WheelOptions): ZoomAction | PanAction | null {
  const zoom = (): ZoomAction => ({
    kind: InputActionKind.Zoom,
    x: wheel.x,
    y: wheel.y,
    factor: wheelZoomFactor({ deltaY: wheel.deltaY, deltaMode: wheel.deltaMode, ctrlKey: wheel.ctrlKey }, options.pageSizePx),
  });

  if (wheel.ctrlKey || wheel.metaKey) return zoom();

  const dx = normalizeWheelDelta(wheel.deltaX, wheel.deltaMode, options.pageSizePx);
  const dy = normalizeWheelDelta(wheel.deltaY, wheel.deltaMode, options.pageSizePx);

  let horizontal = 0;
  if (wheel.shiftKey) horizontal = dx !== 0 ? dx : dy;
  else if (Math.abs(dx) > Math.abs(dy)) horizontal = dx;
  if (horizontal !== 0) return { kind: InputActionKind.Pan, dx: -horizontal, dy: 0 };
  if (wheel.shiftKey) return null;

  return options.wheelZoom && dy !== 0 ? zoom() : null;
}

/**
 * Translate a key press into one a view handles, or `null`. Only the keys of
 * {@link Key} are translated, and not when Ctrl, Alt or Meta is held: those
 * chords (Ctrl+0 and Cmd+- zoom the page, Ctrl+F finds) belong to the browser
 * and the shell. Shift is allowed and reported.
 *
 * @param event - A `KeyboardEvent`, or any object with its fields.
 */
export function normalizeKey(event: KeyLike): KeyInput | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  const key = KEYS.get(event.key);
  return key === undefined ? null : { key, shiftKey: event.shiftKey, repeat: event.repeat };
}

/**
 * Whether a node takes keyboard input of its own: an `input`, `textarea` or
 * `select`, or anything inside a `contenteditable` region. A key pressed there
 * must reach the field, not the view (the old element swallowed characters typed
 * into its filter fields).
 *
 * @param node - Usually the innermost element of the event's `composedPath()`.
 */
export function isFormField(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const element = node as { readonly tagName?: unknown; readonly isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === 'string' && FORM_TAGS.has(element.tagName.toUpperCase());
}
