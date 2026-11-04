/**
 * The element builder: classes through classList (split and flattened, falsy
 * skipped), attributes through setAttribute with their boolean rules, `style`
 * and `on…` refused, children flattened and text kept as text, and no markup
 * API touched. The "document" is a fake element tree that throws if anything
 * reaches for innerHTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuilder, h, type ElementFactory } from '../../src/kit/dom.ts';

/** An element with just what the builder may use, and traps on everything it must not. */
class FakeElement {
  readonly tag: string;
  readonly attributes = new Map<string, string>();
  readonly classes: string[] = [];
  readonly children: Array<FakeElement | string> = [];
  textWrites = 0;
  appendCalls = 0;
  readonly classList = {
    add: (...tokens: string[]): void => {
      for (const token of tokens) {
        if (token === '' || /\s/.test(token)) throw new Error(`InvalidCharacterError: the token ${JSON.stringify(token)} is not a class name`);
        if (!this.classes.includes(token)) this.classes.push(token);
      }
    },
  };

  constructor(tag: string) {
    this.tag = tag;
    for (const forbidden of ['innerHTML', 'outerHTML']) {
      Object.defineProperty(this, forbidden, {
        set() {
          throw new Error(`${forbidden} must not be used`);
        },
      });
    }
    Object.defineProperty(this, 'insertAdjacentHTML', {
      value() {
        throw new Error('insertAdjacentHTML must not be used');
      },
    });
  }

  get textContent(): string {
    return this.children.filter((child): child is string => typeof child === 'string').join('');
  }

  set textContent(value: string) {
    this.textWrites++;
    this.children.length = 0;
    if (value !== '') this.children.push(value);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: Array<FakeElement | string>): void {
    this.appendCalls++;
    this.children.push(...nodes);
  }
}

const factory: ElementFactory = {
  createElement<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return new FakeElement(tag) as unknown as HTMLElementTagNameMap[K];
  },
};
const build = createBuilder(factory);

/** The fake behind an element the builder returned. */
function fake(element: Node | Element): FakeElement {
  return element as unknown as FakeElement;
}

test('builds an element of the given tag with nothing on it', () => {
  const element = fake(build('div'));
  assert.equal(element.tag, 'div');
  assert.deepEqual([...element.attributes], []);
  assert.deepEqual(element.classes, []);
  assert.deepEqual(element.children, []);
  assert.equal(element.textWrites + element.appendCalls, 0);

  assert.equal(fake(build('span', null)).tag, 'span');
  assert.equal(fake(build('button', {})).tag, 'button');
});

test('class takes a string, a list, or nothing, skips what is falsy, and splits composed class strings', () => {
  assert.deepEqual(fake(build('div', { class: 'row' })).classes, ['row']);
  assert.deepEqual(fake(build('div', { class: 'row  selected\tactive\n' })).classes, ['row', 'selected', 'active'], 'a composed vanilla-extract class is several tokens');
  assert.deepEqual(fake(build('div', { class: ['a', false, 'b c', null, undefined, ['d', ['e', false]], ''] })).classes, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(fake(build('div', { class: ['a', 'a', 'b a'] })).classes, ['a', 'b'], 'no duplicates');

  const selected = false;
  assert.deepEqual(fake(build('div', { class: ['row', selected && 'selected'] })).classes, ['row']);
  for (const nothing of [undefined, null, false, '', '   ', []] as const) {
    assert.deepEqual(fake(build('div', { class: nothing })).classes, [], JSON.stringify(nothing));
  }
});

test('attributes are set as text; null and undefined leave them out', () => {
  const element = fake(build('div', { id: 'a', tabindex: 0, 'data-x': 'y', title: undefined, role: null, width: 12.5, empty: '' }));
  assert.deepEqual(Object.fromEntries(element.attributes), { id: 'a', tabindex: '0', 'data-x': 'y', width: '12.5', empty: '' });
});

test('a boolean is written out for aria-* and data-*, and is presence for other attributes', () => {
  const element = fake(
    build('div', {
      'aria-selected': false,
      'aria-expanded': true,
      'ARIA-Busy': false,
      'data-open': true,
      'data-closed': false,
      hidden: true,
      disabled: false,
      draggable: true,
    }),
  );
  assert.deepEqual(Object.fromEntries(element.attributes), {
    'aria-selected': 'false',
    'aria-expanded': 'true',
    'ARIA-Busy': 'false',
    'data-open': 'true',
    'data-closed': 'false',
    hidden: '',
    draggable: '',
  });
});

test('a style attribute and inline event handlers are refused', () => {
  assert.throws(() => build('div', { style: 'color: red' }), /style attribute.*vanilla-extract/);
  assert.throws(() => build('div', { style: undefined }), /style attribute/, 'even an empty one: the key itself is the mistake');
  for (const name of ['onclick', 'onClick', 'onerror', 'ONLOAD', 'onpointerdown']) {
    assert.throws(() => build('div', { [name]: 'alert(1)' }), new RegExp(`${name}.*addEventListener`), name);
  }
  for (const name of ['aria-label', 'data-on', 'role', 'content']) {
    assert.doesNotThrow(() => build('div', { [name]: 'x' }), name);
  }
  assert.throws(() => build('div', { one: 'x' }), /not allowed/, 'anything that starts with "on" is refused, there is no attribute that does so legitimately');
});

test('an attribute that is a list is a mistake, not text', () => {
  assert.throws(() => build('div', { role: ['a', 'b'] }), /attribute "role"/);
});

test('a single text child becomes textContent, and numbers are text too', () => {
  const label = fake(build('span', null, 'hello'));
  assert.equal(label.textContent, 'hello');
  assert.equal(label.textWrites, 1);
  assert.equal(label.appendCalls, 0);

  assert.equal(fake(build('span', null, 42)).textContent, '42');
  assert.equal(fake(build('span', null, 0)).textContent, '0', 'zero is text, not nothing');
  assert.equal(fake(build('span', null, ['only', false])).textContent, 'only');
});

test('children are appended in order, lists flattened, and nothing (false, null, undefined) skipped', () => {
  const inner = build('b', null, 'bold');
  const element = fake(build('p', { class: 'x' }, 'before ', inner, [' middle ', [build('i')], false], null, undefined, ' after', 7, false));

  assert.equal(element.appendCalls, 1);
  assert.deepEqual(
    element.children.map((child) => (typeof child === 'string' ? child : child.tag)),
    ['before ', 'b', ' middle ', 'i', ' after', '7'],
    'strings stay strings, in order',
  );
});

test('conditional and mapped children read naturally', () => {
  const items = ['a', 'b', 'c'];
  const showBadge = false;
  const list = fake(build('ul', null, items.map((item) => build('li', null, item)), showBadge && build('span', null, 'new')));
  assert.deepEqual(list.children.map((child) => (typeof child === 'string' ? child : child.tag)), ['li', 'li', 'li']);
  assert.deepEqual(list.children.map((child) => (typeof child === 'string' ? child : child.textContent)), ['a', 'b', 'c']);

  assert.deepEqual(fake(build('div', null, false, null, undefined)).children, [], 'all nothing: empty');
  assert.equal(fake(build('div', null, false, null)).textWrites + fake(build('div', null)).appendCalls, 0);
});

test('text is only ever text: markup in a string is not parsed and no HTML API is touched', () => {
  const hostile = '<img src=x onerror=alert(1)> & "quotes"';
  const element = fake(build('div', { title: hostile, 'aria-label': hostile }, hostile));
  assert.equal(element.textContent, hostile);
  assert.deepEqual(element.children, [hostile]);
  assert.equal(element.attributes.get('title'), hostile);

  const mixed = fake(build('div', null, hostile, build('b', null, hostile)));
  assert.equal(mixed.children[0], hostile);
  // Reaching for innerHTML, outerHTML or insertAdjacentHTML would have thrown from the fake.
});

test('h uses the page\'s document, looked up when it is called', () => {
  assert.equal(Reflect.get(globalThis, 'document'), undefined, 'this test needs a page without a document');
  assert.throws(() => h('div'), /createBuilder/, 'without a document it says what to use instead');

  const created: FakeElement[] = [];
  Reflect.set(globalThis, 'document', {
    createElement(tag: string) {
      const element = new FakeElement(tag);
      created.push(element);
      return element;
    },
  });
  try {
    const element = fake(h('section', { class: 'panel', role: 'region' }, 'text'));
    assert.deepEqual(created, [element]);
    assert.equal(element.tag, 'section');
    assert.deepEqual(element.classes, ['panel']);
    assert.equal(element.attributes.get('role'), 'region');
    assert.equal(element.textContent, 'text');
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
});

test('createBuilder ignores the page\'s document', () => {
  const mine: FakeElement[] = [];
  const builder = createBuilder({
    createElement<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
      const element = new FakeElement(tag);
      mine.push(element);
      return element as unknown as HTMLElementTagNameMap[K];
    },
  });
  Reflect.set(globalThis, 'document', {
    createElement() {
      throw new Error('the page\'s document must not be used');
    },
  });
  try {
    builder('div', null, builder('span'));
    assert.deepEqual(mine.map((element) => element.tag), ['span', 'div'], 'the child is built before its parent');
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
  }
});
