/**
 * The theme probe resolves every token through the (fake) stylesheet and tells dark from light.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  KIND_TOKENS,
  ThemeProbe,
  luminanceOf,
  tokenRecord,
  type ColorToken,
  type ProbeClasses,
} from '../../src/kit/theme/theme.ts';

class FakeElement {
  className = '';
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  removed = false;
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  remove(): void { this.removed = true; }
}

const classes: ProbeClasses = {
  container: 'probe',
  color: tokenRecord(COLOR_TOKENS, (token) => `c-${token}`),
  font: tokenRecord(FONT_TOKENS, (token) => `f-${token}`),
};

function probeWith(values: Partial<Record<ColorToken, string>>) {
  const root = new FakeElement();
  const probe = new ThemeProbe(root as unknown as { append(...nodes: Node[]): void }, classes, {
    createElement: () => new FakeElement() as unknown as HTMLElement,
    computedStyle: (element) => {
      const { className } = element as unknown as FakeElement;
      const token = className.slice(2);
      return className.startsWith('c-')
        ? { backgroundColor: values[token as ColorToken] ?? 'rgb(1, 2, 3)', fontFamily: '' }
        : { backgroundColor: '', fontFamily: `family of ${token}` };
    },
  });
  return { root, probe };
}

test('the probe puts one hidden container in the root, with an element per token', () => {
  const { root } = probeWith({});
  assert.equal(root.children.length, 1);
  const container = root.children[0];
  assert.equal(container.className, 'probe');
  assert.equal(container.attributes.get('aria-hidden'), 'true');
  assert.equal(container.children.length, COLOR_TOKENS.length + FONT_TOKENS.length);
});

test('resolve reads every colour and font as the stylesheet resolves it', () => {
  const { probe } = probeWith({ text: 'rgb(10, 20, 30)', kindServer: 'rgb(0, 255, 0)' });
  const theme = probe.resolve();
  assert.equal(theme.colors.text, 'rgb(10, 20, 30)');
  assert.equal(theme.colors.accent, 'rgb(1, 2, 3)');
  assert.equal(theme.fonts.sans, 'family of sans');
  assert.equal(theme.fonts.mono, 'family of mono');
  assert.equal(theme.kindColors.length, 6);
  assert.equal(theme.kindColors[KIND_TOKENS.indexOf('kindServer')], 'rgb(0, 255, 0)');
});

test('a dark background makes the theme dark', () => {
  assert.equal(probeWith({ background: 'rgb(255, 255, 255)' }).probe.resolve().dark, false);
  assert.equal(probeWith({ background: 'rgb(27, 29, 35)' }).probe.resolve().dark, true);
  assert.equal(probeWith({ background: 'color(display-p3 0 0 0)' }).probe.resolve().dark, false, 'unreadable: assume light');
});

test('luminanceOf reads the forms getComputedStyle returns', () => {
  assert.equal(luminanceOf('rgb(0, 0, 0)'), 0);
  assert.ok(Math.abs((luminanceOf('rgb(255, 255, 255)') ?? 0) - 1) < 1e-9);
  assert.ok(luminanceOf('rgba(255, 255, 255, 0.5)') !== undefined);
  assert.ok(luminanceOf('rgb(255 255 255 / 0.5)') !== undefined);
  assert.equal(luminanceOf('transparent'), undefined);
});

test('dispose removes the container', () => {
  const { root, probe } = probeWith({});
  probe.dispose();
  assert.equal(root.children[0].removed, true);
});

test('the token tables have no duplicates and the kinds are six', () => {
  assert.equal(new Set(COLOR_TOKENS).size, COLOR_TOKENS.length);
  assert.equal(KIND_TOKENS.length, 6);
  for (const token of KIND_TOKENS) assert.ok(COLOR_TOKENS.includes(token));
});
