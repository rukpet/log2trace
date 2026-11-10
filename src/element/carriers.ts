/**
 * Configuration carriers: `<trace-view>`, `<trace-filter>` and `<span-kind-rule>`.
 *
 * They render nothing and have no Shadow DOM. They are children of `<trace-visualizer>` that carry
 * view declarations, filter fields or span-kind rules in their attributes; the host reads them with
 * `readConfig` and is told through `_rerender()` whenever one of them is added, changed or removed.
 */

/** The element that reads the carriers among its children. */
const CONFIG_HOST = 'trace-visualizer';

/** What a carrier needs of its host: to be told that its configuration changed. */
export interface ConfigHost extends HTMLElement {
  _rerender(carrier?: HTMLElement): void;
}

function isConfigHost(el: Element | null): el is ConfigHost {
  return el !== null && typeof (el as Partial<ConfigHost>)._rerender === 'function';
}

const ElementBase: { new(): HTMLElement } =
  typeof HTMLElement !== 'undefined' ? HTMLElement : (class {} as unknown as { new(): HTMLElement });

/** Shared lifecycle: find the host (waiting for its upgrade if needed) and report every change to it. */
export abstract class ConfigCarrier extends ElementBase {
  private host: ConfigHost | null = null;

  protected notify(): void {
    this.host?._rerender(this);
  }

  connectedCallback(): void {
    const el = this.closest?.(CONFIG_HOST) ?? null;
    this.host = isConfigHost(el) ? el : null;
    if (this.host === null && el !== null) {
      // the host is in the document but not upgraded yet
      void customElements.whenDefined(el.localName).then(() => {
        const upgraded = this.closest?.(CONFIG_HOST) ?? null;
        this.host = isConfigHost(upgraded) ? upgraded : null;
        this.notify();
      });
      return;
    }
    this.notify();
  }

  disconnectedCallback(): void {
    this.notify();
    this.host = null;
  }

  attributeChangedCallback(): void {
    this.notify();
  }
}

/** `<trace-view type="..." label="..." active>`: one view tab and its view-specific options. */
export class TraceViewElement extends ConfigCarrier {
  static get observedAttributes(): string[] {
    return [
      'type', 'label', 'active',
      // waterfall attributes
      'renderer', 'wheel-zoom', 'span-height', 'span-padding', 'gutter-width',
      // sequence attributes
      'sequence-internal', 'sequence-returns', 'sequence-fold', 'row-height',
    ];
  }
}

/** `<trace-filter field="..." type="...">`: one filter field. */
export class TraceFilterElement extends ConfigCarrier {
  static get observedAttributes(): string[] {
    return [
      'field', 'label', 'type', 'source', 'target', 'required',
      'options', 'options-source', 'placeholder', 'debounce', 'width',
    ];
  }
}

/** `<span-kind-rule kind="..." match-field="..." match-value="...">`: one span-kind classification rule. */
export class SpanKindRuleElement extends ConfigCarrier {
  static get observedAttributes(): string[] {
    return ['kind', 'match-field', 'match-value', 'match'];
  }
}

if (typeof customElements !== 'undefined') {
  if (!customElements.get('trace-view')) customElements.define('trace-view', TraceViewElement);
  if (!customElements.get('trace-filter')) customElements.define('trace-filter', TraceFilterElement);
  if (!customElements.get('span-kind-rule')) customElements.define('span-kind-rule', SpanKindRuleElement);
}
