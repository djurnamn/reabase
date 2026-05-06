import type { FxFingerprint } from "./types.js";

export type DiffAction =
  | { type: "unchanged"; fx: FxFingerprint }
  | { type: "modified"; oldFx: FxFingerprint; newFx: FxFingerprint }
  | { type: "added"; fx: FxFingerprint }
  | { type: "removed"; fx: FxFingerprint };

export interface DiffResult {
  actions: DiffAction[];
  /**
   * True when slot IDs present in BOTH chains appear in different relative
   * orders. Reorder is independent of add/remove: a chain can have both an
   * added plugin AND a reorder of the slots that survived.
   */
  reordered: boolean;
}

/**
 * Compute a diff between two FX chains.
 * Matches FX plugins by slotId — each slotId is unique so matching is 1:1.
 */
export function diffFxChains(
  oldChain: FxFingerprint[],
  newChain: FxFingerprint[]
): DiffResult {
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

  return { actions, reordered: chainsReordered(oldChain, newChain) };
}

/**
 * Detect whether the slot IDs present in BOTH chains appear in different
 * relative orders. Slots present in only one chain are ignored — those are
 * captured as add/remove actions, not reorders.
 *
 * Exposed for callers that need just the order signal without recomputing
 * the full diff (e.g., the bridge inspect path, which already has merge
 * actions and just needs to know about reorder).
 */
export function chainsReordered(
  oldChain: FxFingerprint[],
  newChain: FxFingerprint[]
): boolean {
  const newSlotIds = new Set(newChain.map((fx) => fx.slotId));
  const oldSlotIds = new Set(oldChain.map((fx) => fx.slotId));

  const commonOld: string[] = [];
  for (const fx of oldChain) {
    if (newSlotIds.has(fx.slotId)) commonOld.push(fx.slotId);
  }
  const commonNew: string[] = [];
  for (const fx of newChain) {
    if (oldSlotIds.has(fx.slotId)) commonNew.push(fx.slotId);
  }

  if (commonOld.length !== commonNew.length) return false;
  for (let i = 0; i < commonOld.length; i++) {
    if (commonOld[i] !== commonNew[i]) return true;
  }
  return false;
}
