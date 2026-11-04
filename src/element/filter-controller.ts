/**
 * Filter controller: joins the filter bar, the filter model, the store and the data source.
 *
 * - A local filter narrows the spans that are loaded: the model matches them and the result goes
 *   into the store as the filter mask, which every view honours.
 * - An external filter asks the data source for other data: the controller fetches (at once, or when
 *   Search is pressed), indexes the answer and puts it into the store. A required external filter
 *   without a value holds the data back.
 * - Every change a user makes is reported as a `filter-changed` event.
 *
 * It draws nothing itself (the bar is given), so it is tested in Node with a fake bar.
 */

import type { FetchCallback, FilterSource, FilterValue } from '../core/config.ts';
import { FilterModel } from '../core/filter-model.ts';
import { buildSpanIndex } from '../core/span-index.ts';
import type { TraceStore } from '../core/store.ts';
import type { TraceVisualizerConfig } from './config.ts';
import { fetchFiltered, payloadToIndex, type FetchLike } from './data-source.ts';

/** What the controller needs of the filter bar. */
export interface FilterBarLike {
  update(model: FilterModel, autoFetch: boolean): void;
  dispose(): void;
}

/** What the bar tells the controller; the real bar and a fake both take these. */
export interface FilterBarEvents {
  onChange(field: string, source: FilterSource, value: FilterValue): void;
  onSearch(): void;
  onClear(): void;
}

/** What the controller needs of the element. */
export interface FilterHost {
  readonly store: TraceStore;
  config(): TraceVisualizerConfig;
  fetchCallback(): FetchCallback | null;
  /** Dispatch a bubbling, composed custom event. */
  dispatch(type: string, detail: unknown): void;
  /** The state the status message depends on (fetching, required fields) changed. */
  statusChanged(): void;
  readonly fetchImpl?: FetchLike;
}

/** The index of nothing, shown while required filters are unfilled and after a failed fetch. */
function emptyIndex(): ReturnType<typeof buildSpanIndex> {
  return buildSpanIndex({ resourceSpans: [] });
}

/** The controller of one element's filters. */
export class FilterController<B extends FilterBarLike = FilterBarLike> {
  readonly model = new FilterModel();
  /** The bar the factory made. */
  readonly bar: B;
  private readonly host: FilterHost;
  private isFetching = false;
  private fetchToken = 0;

  /**
   * @param host - The element.
   * @param createBar - Makes the bar, given the handlers it must call.
   */
  constructor(host: FilterHost, createBar: (events: FilterBarEvents) => B) {
    this.host = host;
    this.bar = createBar({
      onChange: (field, source, value) => this.change(field, source, value),
      onSearch: () => void this.fetch(),
      onClear: () => this.clear(),
    });
  }

  /** Whether an external fetch is running. */
  get fetching(): boolean {
    return this.isFetching;
  }

  hasExternal(): boolean {
    return this.model.hasExternal();
  }

  /** The configuration changed: take the filter configs and draw them. */
  configure(): void {
    this.model.configure(this.host.config().filterConfigs ?? []);
    this.refresh();
    this.host.statusChanged();
  }

  /** The data changed: learn `auto` options from it, draw the bar and apply the local filters to it. */
  refresh(): void {
    this.model.fillFromData(this.host.store.state.data.index);
    this.bar.update(this.model, this.host.config().autoFetch !== false);
    this.applyLocal();
  }

  /** Put the local filters' result into the store. */
  applyLocal(): void {
    const { index } = this.host.store.state.data;
    this.host.store.setMatched(index.size === 0 ? null : this.model.match(index));
  }

  private change(field: string, source: FilterSource, value: FilterValue): void {
    this.model.set(field, source, value);
    this.bar.update(this.model, this.host.config().autoFetch !== false);
    this.host.dispatch('filter-changed', { field, source, value, allFilters: this.model.allValues() });
    if (source === 'external') {
      if (this.host.config().autoFetch !== false) void this.fetch();
      else this.host.statusChanged();
    } else {
      this.applyLocal();
    }
  }

  private clear(): void {
    this.model.clearLocal();
    this.bar.update(this.model, this.host.config().autoFetch !== false);
    this.applyLocal();
  }

  /** Ask the data source for the data the external filters describe. */
  async fetch(): Promise<void> {
    const token = ++this.fetchToken;
    if (this.model.requiredUnfilled()) {
      this.host.store.setData(emptyIndex());
      this.host.statusChanged();
      return;
    }

    const config = this.host.config();
    this.isFetching = true;
    this.host.statusChanged();
    try {
      const payload = await fetchFiltered({
        url: config.dataUrl,
        params: this.model.queryParams(),
        callback: this.host.fetchCallback(),
        fetchImpl: this.host.fetchImpl,
      });
      if (payload !== null && token === this.fetchToken) this.host.store.setData(payloadToIndex(payload, config));
    } catch {
      if (token === this.fetchToken) this.host.store.setData(emptyIndex());
    } finally {
      if (token === this.fetchToken) {
        this.isFetching = false;
        this.host.statusChanged();
      }
    }
  }

  dispose(): void {
    this.fetchToken++;
    this.bar.dispose();
  }
}
