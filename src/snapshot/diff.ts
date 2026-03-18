import type { FxFingerprint } from "./types.js";

export type DiffAction =
  | { type: "unchanged"; fx: FxFingerprint }
  | { type: "modified"; oldFx: FxFingerprint; newFx: FxFingerprint }
  | { type: "added"; fx: FxFingerprint }
  | { type: "removed"; fx: FxFingerprint };

/**
 * Compute a diff between two FX chains.
 * Matches FX plugins by slotId — each slotId is unique so matching is 1:1.
 */
export function diffFxChains(
  oldChain: FxFingerprint[],
  newChain: FxFingerprint[]
): DiffAction[] {
  const actions: DiffAction[] = [];

  // Build slot lookup for new chain
  const newBySlotId = new Map<string, FxFingerprint>();
  for (const fx of newChain) {
    newBySlotId.set(fx.slotId, fx);
  }

  // Track which new chain slotIds have been matched
  const matchedNewSlotIds = new Set<string>();

  // Process old chain items: check for unchanged, modified, or removed
  for (const oldFx of oldChain) {
    const newFx = newBySlotId.get(oldFx.slotId);

    if (newFx) {
      matchedNewSlotIds.add(oldFx.slotId);
      if (oldFx.stateHash === newFx.stateHash) {
        actions.push({ type: "unchanged", fx: oldFx });
      } else {
        actions.push({ type: "modified", oldFx, newFx });
      }
    } else {
      actions.push({ type: "removed", fx: oldFx });
    }
  }

  // Process new chain items that weren't matched: added
  for (const newFx of newChain) {
    if (!matchedNewSlotIds.has(newFx.slotId)) {
      actions.push({ type: "added", fx: newFx });
    }
  }

  return actions;
}
