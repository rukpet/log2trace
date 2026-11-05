/**
 * Shell: how the view tabs move
 *
 * The keyboard behaviour of a tab list, apart from the DOM so it can be tested in Node: arrows
 * move to the neighbour and wrap around, Home and End jump to the ends.
 */

/**
 * The tab a key moves to.
 *
 * @param ids - The ids of the tabs, in order.
 * @param current - The id of the focused tab.
 * @param key - A `KeyboardEvent.key` value.
 * @returns The id to move to, or `null` when the key is not a tab key or there is nowhere to go.
 */
export function tabAfterKey(ids: readonly string[], current: string, key: string): string | null {
  const at = ids.indexOf(current);
  if (at < 0 || ids.length < 2) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return ids[(at + 1) % ids.length];
    case 'ArrowLeft':
    case 'ArrowUp':
      return ids[(at - 1 + ids.length) % ids.length];
    case 'Home':
      return ids[0];
    case 'End':
      return ids[ids.length - 1];
    default:
      return null;
  }
}
