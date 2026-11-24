/**
 * Kit input: vocabulary
 *
 * Input reaches a view as plain data, not DOM events. The binding turns
 * pointer, wheel, gesture and key events into the values defined here, a pure
 * reducer turns the pointer ones into actions, and the view's own reducer (camera
 * and store changes) takes the actions: no DOM object crosses a layer, so every
 * step runs in Node.
 *
 * Coordinates are CSS px in the bound element's own frame: 0, 0 is the top left
 * of its padding box, so a view can use them for hit testing and cursor-anchored
 * zoom as they are.
 */

/** Modifier keys held while an event happened. */
export interface Modifiers {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/**
 * The keys a view reacts to. Anything else is not translated and keeps its
 * browser behaviour. Several physical keys can map to one name: `+` and `=` are
 * both {@link Key.Plus}, `-` and `_` both {@link Key.Minus}.
 */
export enum Key {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Home,
  End,
  PageUp,
  PageDown,
  Enter,
  Space,
  Escape,
  /** `+` or `=`: zoom in. */
  Plus,
  /** `-` or `_`: zoom out. */
  Minus,
  /** `0`: reset the view. */
  Zero,
  /** i or I: toggle/cycle internal spans. */
  I,
  /** f or F: toggle column fitting. */
  F,
  /** r or R: jump between request and return arrow. */
  R,
  /** e or E: jump to next/previous error step. */
  E,
}

/** A key press a view may handle, as returned by `normalizeKey`. */
export interface KeyInput {
  readonly key: Key;
  /** Shift was held (the other modifiers never are: chords with Ctrl, Alt or Meta are not translated). */
  readonly shiftKey: boolean;
  /** The key is auto-repeating because it is held down. */
  readonly repeat: boolean;
}

/** What a wheel event says, in plain data; `deltaMode` still has to be normalised. */
export interface WheelInput extends Modifiers {
  /** Cursor position, bound element's frame. */
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  /** The event's `deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
}

/** The kinds of {@link InputAction}. */
export enum InputActionKind {
  /** The pointer moved over the surface with nothing pressed. */
  Hover,
  /** The pointer left the surface. */
  HoverEnd,
  /** A press and release without movement. */
  Click,
  /** The browser's double click. */
  DoubleClick,
  /** A drag began: the pointer moved far enough from where it went down, or a second finger came down. */
  PanStart,
  /** Content moved by a drag, a pinch's midpoint, or a horizontal wheel. */
  Pan,
  /** A drag, or a pinch, ended. */
  PanEnd,
  /** Zoom around a point: a pinch, a ctrl+wheel, a wheel in wheel-zoom mode, a Safari gesture. */
  Zoom,
  /** A key a view handles was pressed. */
  KeyDown,
}

/** The pointer moved over the surface with nothing pressed (mouse, pen). */
export interface HoverAction {
  readonly kind: InputActionKind.Hover;
  readonly x: number;
  readonly y: number;
}

/** The pointer left the surface. */
export interface HoverEndAction {
  readonly kind: InputActionKind.HoverEnd;
}

/** A press and release without movement (a tap on touch screens). */
export interface ClickAction extends Modifiers {
  readonly kind: InputActionKind.Click;
  readonly x: number;
  readonly y: number;
}

/** The browser's double click. */
export interface DoubleClickAction extends Modifiers {
  readonly kind: InputActionKind.DoubleClick;
  readonly x: number;
  readonly y: number;
}

/**
 * A drag began, at the point where the pointer went down (for a pinch, the
 * midpoint of the two fingers). Pointer capture is taken here. The first `Pan`
 * brings the content up to the pointer, so the drag threshold costs no lag.
 */
export interface PanStartAction {
  readonly kind: InputActionKind.PanStart;
  readonly x: number;
  readonly y: number;
}

/**
 * Content moved by `dx`, `dy` px since the previous `Pan` or `PanStart`.
 * Positive `dx` means the content moves right (drag right, reveal earlier
 * times: `panByPx(camera, dx)`), positive `dy` means it moves down. Also sent on
 * its own, outside a drag, for a horizontal wheel or Shift+wheel, with the same
 * meaning: a wheel that scrolls right gives a negative `dx`.
 */
export interface PanAction {
  readonly kind: InputActionKind.Pan;
  readonly dx: number;
  readonly dy: number;
}

/**
 * A drag or a pinch ended. `cancelled` is true when the system took the
 * gesture away (`pointercancel`, lost capture) rather than the user letting go;
 * the view normally just stops, keeping where the camera is.
 */
export interface PanEndAction {
  readonly kind: InputActionKind.PanEnd;
  readonly cancelled: boolean;
}

/**
 * Zoom around a point. `factor` is the multiplier of the window length, as
 * `zoomAt(camera, pxToTime(camera, x), factor)` takes it: below 1 zooms in. It
 * is always positive and finite.
 */
export interface ZoomAction {
  readonly kind: InputActionKind.Zoom;
  readonly x: number;
  readonly y: number;
  readonly factor: number;
}

/** A key the view handles. */
export interface KeyDownAction extends KeyInput {
  readonly kind: InputActionKind.KeyDown;
}

/** Everything the binding reports to a view. */
export type InputAction =
  | HoverAction
  | HoverEndAction
  | ClickAction
  | DoubleClickAction
  | PanStartAction
  | PanAction
  | PanEndAction
  | ZoomAction
  | KeyDownAction;

/** The kinds of {@link GestureEvent}. */
export enum GestureEventKind {
  PointerDown,
  PointerMove,
  PointerUp,
  PointerCancel,
  PointerLeave,
  DoubleClick,
  /** Safari's `gesturestart`: a trackpad or touch pinch began. */
  SafariGestureStart,
  /** Safari's `gesturechange`. */
  SafariGestureChange,
  /** Safari's `gestureend`. */
  SafariGestureEnd,
}

/** A pointer went down. */
export interface PointerDownEvent extends Modifiers {
  readonly kind: GestureEventKind.PointerDown;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  /** The event's `button`: only 0 (primary button, touch contact, pen tip) starts a gesture. */
  readonly button: number;
}

/** A pointer moved. */
export interface PointerMoveEvent {
  readonly kind: GestureEventKind.PointerMove;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

/** A pointer was released. */
export interface PointerUpEvent extends Modifiers {
  readonly kind: GestureEventKind.PointerUp;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

/** The system cancelled a pointer, or its capture was lost. */
export interface PointerCancelEvent {
  readonly kind: GestureEventKind.PointerCancel;
  readonly pointerId: number;
}

/** A pointer left the element without capture. */
export interface PointerLeaveEvent {
  readonly kind: GestureEventKind.PointerLeave;
  readonly pointerId: number;
}

/** The browser's `dblclick`. */
export interface DoubleClickEvent extends Modifiers {
  readonly kind: GestureEventKind.DoubleClick;
  readonly x: number;
  readonly y: number;
}

/** Safari's `gesturestart`, `gesturechange` or `gestureend`; `scale` is cumulative since the start, 1 at the start. */
export interface SafariGestureEvent {
  readonly kind: GestureEventKind.SafariGestureStart | GestureEventKind.SafariGestureChange | GestureEventKind.SafariGestureEnd;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** An event for the gesture reducer. */
export type GestureEvent =
  | PointerDownEvent
  | PointerMoveEvent
  | PointerUpEvent
  | PointerCancelEvent
  | PointerLeaveEvent
  | DoubleClickEvent
  | SafariGestureEvent;
