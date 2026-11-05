/**
 * Kit: what the page configured, as a view reads it
 *
 * The element does not know what any view can be configured with. It hands every view the same two
 * things: the merged configuration (attributes, `<trace-filter>`-style children and the `config`
 * property, by key) and the attributes of the element. A view reads the options it knows with the
 * small readers below, in its own module, into its own typed settings; the options of another view
 * are none of its business and unknown or malformed values read as "not set".
 */

/** How a view that can draw with more than one backend draws. */
export type RendererKind = 'canvas' | 'dom';

/** The configuration of the element as a view sees it. */
export interface ViewOptions {
  /** The merged configuration, by key. */
  readonly config: Readonly<Record<string, unknown>>;
  /** An attribute of the element, or `null` when it is absent. */
  attribute(name: string): string | null;
}

/** A configuration value that is a finite number, else `undefined`. */
export function numberOption(options: ViewOptions, key: string): number | undefined {
  const value = options.config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Whether an attribute is present, whatever its value: the way boolean attributes work in HTML. */
export function flagOption(options: ViewOptions, attribute: string): boolean {
  return options.attribute(attribute) !== null;
}

/** The value of an attribute when it is one of `choices`, else `undefined`. */
export function choiceOption<T extends string>(options: ViewOptions, attribute: string, choices: readonly T[]): T | undefined {
  const value = options.attribute(attribute);
  return choices.find((choice) => choice === value);
}
