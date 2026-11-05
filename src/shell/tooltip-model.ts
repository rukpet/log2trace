/**
 * Shell: where a tooltip goes
 *
 * The one formula the tooltip needs, apart from the DOM: put the box to the right of and below the
 * anchor, and flip it to the left or above when it would leave the container.
 *
 * Headless: no DOM, no browser globals.
 */

/** Where the tooltip points, in the coordinates of its container. */
export interface TooltipAnchor {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Gap between the anchor and the tooltip, px. */
export const TOOLTIP_GAP = 8;

/**
 * The top-left corner of a tooltip of `size` next to `anchor`, kept inside `container`.
 *
 * @param anchor - The element's box.
 * @param size - Size of the tooltip.
 * @param container - Size of the container the tooltip must stay inside.
 */
export function placeTooltip(
  anchor: TooltipAnchor,
  size: { readonly width: number; readonly height: number },
  container: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  let x = anchor.x + anchor.w + TOOLTIP_GAP;
  if (x + size.width > container.width) x = Math.max(0, anchor.x - size.width - TOOLTIP_GAP);
  let y = anchor.y + anchor.h + TOOLTIP_GAP;
  if (y + size.height > container.height) y = Math.max(0, anchor.y - size.height - TOOLTIP_GAP);
  return { x: Math.round(x), y: Math.round(y) };
}
