/**
 * Configuration carriers: `<trace-filter>` and `<span-kind-rule>`.
 *
 * Both render nothing and have no Shadow DOM. They are children of `<trace-visualizer>` that carry
 * one filter field or one span-kind rule in their attributes; the host reads them with
 * `readConfig` and is told through `_rerender()` whenever one of them is added, changed or removed.
 */

/** The element that reads the carriers among its children. */
const CONFIG_HOST = 'trace-visualizer';

/** What a carrier needs of its host: to be told that its configuration changed. */
interface ConfigHost extends HTMLElement {
  _rerender(): void;
}

function isConfigHost(el: Element | null): el is ConfigHost {
  return el !== null && typeof (el as Partial<ConfigHost>)._rerender === 'function';
}

/** Shared lifecycle: find the host (waiting for its upgrade if needed) and report every change to it. */
abstract class ConfigCarrier extends HTMLElement {
  private host: ConfigHost | null = null;

  private notify(): void {
    this.host?._rerender();
  }

  connectedCallback(): void {
    const el = this.closest(CONFIG_HOST);
    this.host = isConfigHost(el) ? el : null;
    if (this.host === null && el !== null) {
      // the host is in the document but not upgraded yet
      void customElements.whenDefined(el.localName).then(() => {
        const upgraded = this.closest(CONFIG_HOST);
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

/** `<trace-filter field="..." type="...">`: one filter field. */
class TraceFilterElement extends ConfigCarrier {
  static get observedAttributes(): string[] {
    return [
      'field', 'label', 'type', 'source', 'target', 'required',
      'options', 'options-source', 'placeholder', 'debounce', 'width',
    ];
  }
}

/** `<span-kind-rule kind="..." match-field="..." match-value="...">`: one span-kind classification rule. */
class SpanKindRuleElement extends ConfigCarrier {
  static get observedAttributes(): string[] {
    return ['kind', 'match-field', 'match-value', 'match'];
  }
}

if (!customElements.get('trace-filter')) customElements.define('trace-filter', TraceFilterElement);
if (!customElements.get('span-kind-rule')) customElements.define('span-kind-rule', SpanKindRuleElement);
