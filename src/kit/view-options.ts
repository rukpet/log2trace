/**
 * Kit: what the page configured, as a view reads it
 *
 * The element does not know what any view can be configured with. It hands every view the same
 * bundle: the merged configuration (`config` property over element attributes and `<trace-filter>` /
 * `<span-kind-rule>` children, by key), the attributes of `<trace-visualizer>`, and (when the view
 * was declared with `<trace-view>`) the attributes of that child element. A view reads the options
 * it knows with the small readers below, in its own module, into its own typed settings; child
 * attributes win over both element attributes and `config`, while unknown or malformed values read
 * as "not set".
 */

/** The configuration of the element as a view sees it. */
export interface ViewOptions {
  /** The merged configuration, by key. */
  readonly config: Readonly<Record<string, unknown>>;
  /** An attribute of the `<trace-visualizer>` element, or `null` when it is absent. */
  attribute(name: string): string | null;
  /** An attribute of the view's own `<trace-view>` child; `null` when absent or when there is no child. Wins over the element and the config. */
  viewAttribute?(name: string): string | null;
}

/** A finite number from the view's `<trace-view>` attribute (if named) or from `config[key]`, else `undefined`. */
export function numberOption(options: ViewOptions, key: string, viewName?: string): number | undefined {
  if (viewName !== undefined) {
    const own = options.viewAttribute?.(viewName);
    if (own != null && own.trim() !== '') {
      const parsed = Number(own);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const value = options.config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Whether a boolean option is enabled, checking `<trace-view>` first (`"false"` disables), else presence on `<trace-visualizer>`. */
export function flagOption(options: ViewOptions, attribute: string, viewName = attribute): boolean {
  const own = options.viewAttribute?.(viewName);
  if (own != null) return own !== 'false';
  return options.attribute(attribute) !== null;
}

/** The value of an attribute when it is one of `choices` (checking `<trace-view>` first, then `<trace-visualizer>`), else `undefined`. */
export function choiceOption<T extends string>(
  options: ViewOptions,
  attribute: string,
  choices: readonly T[],
  viewName = attribute,
): T | undefined {
  const own = options.viewAttribute?.(viewName);
  const ownMatch = own != null ? choices.find((choice) => choice === own) : undefined;
  if (ownMatch !== undefined) return ownMatch;
  const value = options.attribute(attribute);
  return choices.find((choice) => choice === value);
}
