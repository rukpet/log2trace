/**
 * Kit: view commands
 *
 * What a view offers the chrome around it: a list of commands. The toolbar draws a button per
 * command, the key handler runs the command a key is bound to, and the accessibility layer can
 * announce them, all from this one description, so a view adds a command in one place.
 * The shell reads this type and never imports a particular view.
 */

/** A button or key a view offers. */
export interface ViewCommand {
  readonly id: string;
  /** What the button says and a screen reader announces. */
  readonly label: string;
  /** Keys that trigger it, as `KeyboardEvent.key` values. */
  readonly keys?: readonly string[];
  run(): void;
  /** Text to show next to the command, such as the zoom level. */
  readonly readout?: () => string;
  readonly enabled?: () => boolean;
}
