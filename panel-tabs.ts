/** Plugin settings that only change how the panel arranges its tabs. */
export const tabLayoutSettings: readonly string[] = ["tabOrder", "hiddenTabs"];

function savedIds(saved: string) {
  return saved.split(",").map((id) => id.trim());
}

/**
 * Reads the tab order saved as comma-separated tab ids. Unknown and repeated
 * ids are ignored. A tab missing from the saved list is added at its index in
 * `defaults`, so an empty value gives the default order.
 */
export function parseTabOrder<Id extends string>(
  defaults: readonly Id[],
  saved: string,
): Id[] {
  const order: Id[] = [];
  for (const id of savedIds(saved)) {
    if ((defaults as readonly string[]).includes(id) && !(order as string[]).includes(id))
      order.push(id as Id);
  }
  defaults.forEach((id, index) => {
    if (!order.includes(id)) order.splice(Math.min(index, order.length), 0, id);
  });
  return order;
}

/** Reads the hidden tabs saved as comma-separated tab ids. Ids not in `hideable` are ignored. */
export function parseHiddenTabs<Id extends string>(
  hideable: readonly Id[],
  saved: string,
): Set<Id> {
  return new Set(hideable.filter((id) => savedIds(saved).includes(id)));
}

/** Formats tab ids the way `parseTabOrder` and `parseHiddenTabs` read them. */
export function formatTabIds(ids: Iterable<string>) {
  return [...ids].join(",");
}

/** Returns `order` with `id` moved to `index`, clamped to the list bounds. */
export function moveTab<Id extends string>(
  order: readonly Id[],
  id: Id,
  index: number,
): Id[] {
  const rest = order.filter((entry) => entry !== id);
  if (rest.length === order.length) return [...order];
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}
