/**
 * Kit: element builder
 *
 * `h(tag, props, ...children)` builds a DOM element without ever parsing
 * markup: classes go through `classList`, attributes through `setAttribute`,
 * text through `textContent` or as text nodes. A value from a log record can
 * therefore never become markup, and the lint rules that ban `innerHTML` and
 * friends have an alternative to point to. Class names come from the typed
 * exports of the `*.css.ts` files, so a typo fails the build.
 *
 * ```ts
 * h('div', { class: [styles.row, selected && styles.rowSelected], role: 'row', 'aria-selected': selected },
 *   h('span', { class: styles.name }, span.name),
 *   count > 0 && h('span', { class: styles.badge }, count),
 * );
 * ```
 *
 * Styles are not set here: a `style` attribute is refused, and so is any `on…`
 * attribute (inline event handlers); use classes, `element.style.<prop>` and
 * `addEventListener`. The document is taken lazily, on the first call of `h`, or
 * injected through {@link createBuilder}, so the module works in Node tests.
 */

/**
 * Class names: a string (it may hold several, separated by spaces, as the
 * `*.css.ts` exports of composed styles do), nothing at all (`false`, `null`,
 * `undefined`, so `condition && styles.on` works), or a list of these.
 */
export type ClassNames = string | false | null | undefined | readonly ClassNames[];

/** What an attribute can be set to; see {@link ElementProps}. */
export type AttributeValue = string | number | boolean | null | undefined;

/**
 * The props of an element. `class` takes {@link ClassNames}; every other key is
 * an attribute:
 *
 * - `null` and `undefined` leave the attribute out.
 * - A string or a number is set as text.
 * - A boolean for an `aria-*` or `data-*` attribute becomes `"true"` or `"false"`
 *   (`aria-selected="false"` means something other than no attribute).
 * - A boolean for any other attribute is an HTML boolean attribute: `true` sets
 *   it empty (`hidden=""`), `false` leaves it out.
 *
 * `style` and `on…` attributes are refused with an error.
 */
export interface ElementProps {
  readonly class?: ClassNames;
  readonly [attribute: string]: AttributeValue | ClassNames;
}

/**
 * What can be a child: a node, text (a string or a number), nothing (`false`,
 * `null`, `undefined`, for conditional children), or a list of these, which is
 * flattened, so `items.map((item) => h(...))` can be a child as it is.
 */
export type Child = Node | string | number | false | null | undefined | readonly Child[];

/** The part of a document the builder needs. */
export interface ElementFactory {
  /** A new element with the given tag name. */
  createElement<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
}

/** The signature of `h`. */
export type Builder = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElementProps | null,
  ...children: Child[]
) => HTMLElementTagNameMap[K];

/** Attributes whose boolean values are written out as `"true"` and `"false"`. */
const WRITTEN_BOOLEAN = /^(aria|data)-/i;

function isList<T>(value: T | readonly T[]): value is readonly T[] {
  return Array.isArray(value);
}

function addClasses(element: Element, names: ClassNames): void {
  if (typeof names === 'string') {
    for (const token of names.split(/\s+/)) {
      if (token !== '') element.classList.add(token);
    }
  } else if (isList<ClassNames>(names)) {
    for (const name of names) addClasses(element, name);
  }
}

function applyAttribute(element: Element, name: string, value: AttributeValue | ClassNames): void {
  if (name === 'style') {
    throw new Error('h(): a style attribute is not allowed: use a vanilla-extract class, or element.style.<prop> afterwards');
  }
  if (/^on/i.test(name)) {
    throw new Error(`h(): the inline event handler attribute "${name}" is not allowed: use addEventListener`);
  }

  if (value === null || value === undefined) return;
  if (typeof value === 'object') throw new TypeError(`h(): attribute "${name}" must be a string, number or boolean, not a list`);
  if (typeof value === 'boolean') {
    if (WRITTEN_BOOLEAN.test(name)) element.setAttribute(name, String(value));
    else if (value) element.setAttribute(name, '');
    return;
  }
  element.setAttribute(name, String(value));
}

/** Children flattened, with nothing removed, and text converted to strings. */
function collect(children: readonly Child[], into: Array<Node | string>): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (isList<Child>(child)) collect(child, into);
    else if (typeof child === 'number') into.push(String(child));
    else into.push(child);
  }
}

function build<K extends keyof HTMLElementTagNameMap>(
  factory: ElementFactory,
  tag: K,
  props: ElementProps | null | undefined,
  children: readonly Child[],
): HTMLElementTagNameMap[K] {
  const element = factory.createElement(tag);

  if (props) {
    for (const name of Object.keys(props)) {
      const value = props[name];
      if (name === 'class') addClasses(element, value as ClassNames);
      else applyAttribute(element, name, value);
    }
  }

  const content: Array<Node | string> = [];
  collect(children, content);
  if (content.length === 1 && typeof content[0] === 'string') element.textContent = content[0];
  else if (content.length > 0) element.append(...content);
  return element;
}

/**
 * A builder that creates its elements with a given document (or any object
 * with its `createElement`): for a document that is not the page's, or a fake.
 *
 * @param factory - Usually a `Document`.
 */
export function createBuilder(factory: ElementFactory): Builder {
  return (tag, props, ...children) => build(factory, tag, props, children);
}

/**
 * Build an element: its class names, its attributes and its children, with
 * the rules of {@link ElementProps} and {@link Child}. Uses the page's `document`,
 * looked up when it is called.
 *
 * @param tag - The tag name, which also types the result.
 * @param props - `class` and attributes; may be `null` when there are none.
 * @param children - Nodes and text.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: ElementProps | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  if (typeof globalThis.document === 'undefined') {
    throw new Error('h(): there is no document; build elements with createBuilder(document) instead');
  }
  return build(globalThis.document, tag, props, children);
}
