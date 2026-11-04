/**
 * A small fake DOM for painters that build elements: nodes with a class list, attributes, an
 * inline style object, children and `textContent`; a `ResizeObserver` the test fires by hand; and a
 * `document` for the `h()` builder. Only what the DOM painter uses is implemented.
 */

class FakeClassList {
  readonly names = new Set<string>();

  constructor(private readonly owner: FakeElement) {}

  add(...tokens: string[]): void {
    for (const token of tokens) this.names.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.names.delete(token);
  }

  contains(token: string): boolean {
    return this.names.has(token);
  }

  toggle(token: string, force?: boolean): boolean {
    const on = force ?? !this.names.has(token);
    if (on) this.names.add(token);
    else this.names.delete(token);
    return on;
  }

  replace(oldToken: string, newToken: string): boolean {
    if (!this.names.delete(oldToken)) return false;
    this.names.add(newToken);
    return true;
  }

  /** Used by `className` writes. */
  set(value: string): void {
    this.names.clear();
    for (const token of value.split(/\s+/)) if (token !== '') this.names.add(token);
    void this.owner;
  }
}

/** The style object: any property can be written, custom properties through `setProperty`. */
export interface FakeStyle {
  [property: string]: unknown;
  setProperty(name: string, value: string): void;
}

export class FakeElement {
  readonly tag: string;
  readonly classList = new FakeClassList(this);
  readonly attributes = new Map<string, string>();
  readonly style: FakeStyle;
  readonly customProperties = new Map<string, string>();
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  private text = '';

  constructor(tag: string) {
    this.tag = tag;
    const custom = this.customProperties;
    this.style = {
      setProperty(name: string, value: string): void {
        custom.set(name, value);
      },
    };
  }

  get className(): string {
    return [...this.classList.names].join(' ');
  }

  set className(value: string) {
    this.classList.set(value);
  }

  get textContent(): string {
    return this.children.length > 0 ? this.children.map((child) => child.textContent).join('') : this.text;
  }

  set textContent(value: string) {
    this.detachChildren();
    this.text = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) this.attach(node, this.children.length);
  }

  prepend(...nodes: Array<FakeElement | string>): void {
    nodes.forEach((node, i) => this.attach(node, i));
  }

  replaceChildren(...nodes: Array<FakeElement | string>): void {
    this.detachChildren();
    this.append(...nodes);
  }

  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  addEventListener(): void {
    // events are fired by calling the code under test directly
  }

  private attach(node: FakeElement | string, at: number): void {
    if (typeof node === 'string') {
      this.text += node;
      return;
    }
    node.remove();
    node.parent = this;
    this.children.splice(at, 0, node);
  }

  private detachChildren(): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = '';
  }

  /** Every descendant with the class, depth first. */
  findAll(className: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.classList.contains(className)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

/** A `ResizeObserver` the test fires by calling {@link FakeResizeObserver.fire}. */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;

  constructor(private readonly callback: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: unknown): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  fire(width: number, height: number): void {
    this.callback([{ contentRect: { width, height } }]);
  }
}

/** Install a fake `document` and `ResizeObserver`; returns what to call to put the globals back. */
export function installFakeDom(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, ResizeObserver: globals.ResizeObserver };
  globals.document = { createElement: (tag: string) => new FakeElement(tag) };
  globals.ResizeObserver = FakeResizeObserver;
  FakeResizeObserver.instances = [];
  return () => {
    globals.document = saved.document;
    globals.ResizeObserver = saved.ResizeObserver;
  };
}
