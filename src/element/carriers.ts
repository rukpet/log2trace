/**
 * Configuration carriers: `<trace-filter>`, `<span-kind-rule>`, and `<trace-view>`.
 *
 * All three render nothing and have no Shadow DOM. They are children of `<trace-visualizer>` that
 * carry one filter field, one span-kind rule, or one view declaration with its per-view options
 * in their attributes; the host reads them with `readConfig` / `readViews` and is told through
 * `_rerender()` or `_viewsChanged()` whenever one of them is added, changed or removed.
 *
 * @module
 * @internal
 */

/** The element that reads the carriers among its children. */
const CONFIG_HOST = 'trace-visualizer';

/** Attributes of `<trace-view>` that affect tabs or active selection rather than per-view options. */
const VIEW_TAB_ATTRIBUTES = new Set(['type', 'label', 'active']);

/** What a carrier needs of its host: to be told when its configuration or view declarations change. */
interface ConfigHost extends HTMLElement {
  _rerender(): void;
  _viewsChanged(tabsAffected: boolean, viewType?: string | null): void;
}

function isConfigHost(el: Element | null): el is ConfigHost {
  return (
    el !== null
    && typeof (el as Partial<ConfigHost>)._rerender === 'function'
    && typeof (el as Partial<ConfigHost>)._viewsChanged === 'function'
  );
}

/** Shared lifecycle: find the host (waiting for its upgrade if needed) and report every change to it. */
abstract class ConfigCarrier extends HTMLElement {
  private host: ConfigHost | null = null;
  private pendingHost: Element | null = null;

  protected resolveHost(): ConfigHost | null {
    if (this.host !== null) return this.host;
    const candidate = this.isConnected ? this.closest(CONFIG_HOST) : this.pendingHost;
    if (isConfigHost(candidate)) {
      this.host = candidate;
      this.pendingHost = null;
    }
    return this.host;
  }

  protected notify(): void {
    this.resolveHost()?._rerender();
  }

  connectedCallback(): void {
    const el = this.closest(CONFIG_HOST);
    this.host = isConfigHost(el) ? el : null;
    if (this.host === null && el !== null) {
      // The host is in the document but not upgraded yet; attach once defined so later
      // mutations and removals reach it. Its own connectedCallback reads all children already
      // present, so no extra notification is needed on upgrade.
      this.pendingHost = el;
      void customElements.whenDefined(el.localName).then(() => {
        if (!this.isConnected) {
          this.pendingHost = null;
          return;
        }
        const upgraded = this.closest(CONFIG_HOST);
        this.host = isConfigHost(upgraded) ? upgraded : null;
        this.pendingHost = null;
      });
      return;
    }
    this.pendingHost = null;
    this.notify();
  }

  disconnectedCallback(): void {
    this.notify();
    this.host = null;
    this.pendingHost = null;
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

/** `<trace-view type="..." label="..." active ...options>`: one view of the host and its own options. Any attribute can be an option, so all of them are watched. */
class TraceViewElement extends ConfigCarrier {
  private observer: MutationObserver | null = null;

  protected override notify(): void {
    this.resolveHost()?._viewsChanged(true, this.getAttribute('type')?.trim() || null);
  }

  private onAttributes(records: MutationRecord[]): void {
    let tabsAffected = false;
    let optionsAffected = false;
    let typeChanged = false;
    for (const record of records) {
      const name = record.attributeName;
      if (name === null) continue;
      if (name === 'type') {
        tabsAffected = true;
        optionsAffected = true;
        typeChanged = true;
      } else if (VIEW_TAB_ATTRIBUTES.has(name)) {
        tabsAffected = true;
      } else {
        optionsAffected = true;
      }
    }
    if (!tabsAffected && !optionsAffected) return;
    const viewType = optionsAffected
      ? (typeChanged ? undefined : (this.getAttribute('type')?.trim() || null))
      : null;
    if (!tabsAffected && viewType === null) return;
    this.resolveHost()?._viewsChanged(tabsAffected, viewType);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.observer ??= new MutationObserver((records) => this.onAttributes(records));
    this.observer.observe(this, { attributes: true });
  }

  override disconnectedCallback(): void {
    this.observer?.disconnect();
    super.disconnectedCallback();
  }
}

if (!customElements.get('trace-filter')) customElements.define('trace-filter', TraceFilterElement);
if (!customElements.get('span-kind-rule')) customElements.define('span-kind-rule', SpanKindRuleElement);
if (!customElements.get('trace-view')) customElements.define('trace-view', TraceViewElement);
