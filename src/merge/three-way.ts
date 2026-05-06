import type { FxFingerprint } from "../snapshot/types.js";
import type { MergeAction, MergeResult } from "./types.js";

function buildLookup(
  chain: FxFingerprint[]
): Map<string, FxFingerprint> {
  const lookup = new Map<string, FxFingerprint>();
  for (const fx of chain) {
    lookup.set(fx.slotId, fx);
  }
  return lookup;
}

function getOrderedKeys(chain: FxFingerprint[]): string[] {
  return chain.map((fx) => fx.slotId);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Three-way merge of FX chains.
 *
 * Content is decided per-slot via the standard three-way logic
 * (keep_base / use_new_base / keep_local / add_base / add_local /
 * remove / remove_local / conflict).
 *
 * Order is decided once for the whole chain:
 * - If local has reordered the shared slots relative to the snapshot,
 *   local order is the spine — the user's manual reorder is preserved.
 *   Status will report the chain as out-of-order vs the preset until the
 *   user explicitly resets it; that "stable deviation" is by design.
 * - Otherwise the new preset's order is the spine — upstream reorders flow
 *   through to tracks that haven't deviated.
 *
 * Slots that survive but aren't on the spine (preset additions when spine
 * is local; local additions when spine is preset) are injected next to
 * their neighbours in the alternate ordering, so "after X" / "before Y"
 * intent from the preset (or local placement intent) is honoured.
 *
 * @param oldBase - The snapshot of what was last applied (common ancestor)
 * @param newBase - The updated preset definition (upstream changes)
 * @param local - The current track state (local changes)
 */
export function threeWayMerge(
  oldBase: FxFingerprint[],
  newBase: FxFingerprint[],
  local: FxFingerprint[]
): MergeResult {
  const oldLookup = buildLookup(oldBase);
  const newLookup = buildLookup(newBase);
  const localLookup = buildLookup(local);

  const oldKeys = new Set(getOrderedKeys(oldBase));
  const newKeys = new Set(getOrderedKeys(newBase));
  const localKeys = new Set(getOrderedKeys(local));

  // Decide content (action) per slot first — order-independent.
  const allKeys = new Set<string>([...oldKeys, ...newKeys, ...localKeys]);
  const actionByKey = new Map<string, MergeAction>();
  for (const key of allKeys) {
    actionByKey.set(
      key,
      resolveActionForKey(
        key,
        oldLookup.get(key),
        newLookup.get(key),
        localLookup.get(key)
      )
    );
  }

  const survives = (key: string): boolean => {
    const a = actionByKey.get(key);
    return a !== undefined && a.type !== "remove" && a.type !== "remove_local";
  };

  // Decide spine order: prefer local if local has reordered shared slots
  // relative to the snapshot, else prefer new base.
  const localShared = getOrderedKeys(local).filter((k) => oldKeys.has(k));
  const oldSharedRelativeToLocal = getOrderedKeys(oldBase).filter((k) =>
    localKeys.has(k)
  );
  const localReordered = !arraysEqual(localShared, oldSharedRelativeToLocal);

  const localOrder = getOrderedKeys(local);
  const newOrder = getOrderedKeys(newBase);
  const spine = localReordered ? localOrder : newOrder;
  const alternate = localReordered ? newOrder : localOrder;

  // Phase 1: place spine slots that survive, in spine order.
  const placed: string[] = [];
  const placedSet = new Set<string>();
  for (const key of spine) {
    if (placedSet.has(key)) continue;
    if (!survives(key)) continue;
    placed.push(key);
    placedSet.add(key);
  }

  // Phase 2: inject surviving slots that aren't on the spine.
  // Order them by the alternate ordering (so e.g. multiple preset additions
  // arrive in preset order), then anchor each to the closest already-placed
  // neighbour in the alternate ordering.
  const missingOrdered: string[] = [];
  for (const key of alternate) {
    if (placedSet.has(key)) continue;
    if (!survives(key)) continue;
    missingOrdered.push(key);
  }
  // Defensive: any surviving key absent from both orderings — append at end.
  for (const key of allKeys) {
    if (placedSet.has(key)) continue;
    if (!survives(key)) continue;
    if (!missingOrdered.includes(key)) {
      missingOrdered.push(key);
    }
  }

  for (const missing of missingOrdered) {
    const altIndex = alternate.indexOf(missing);
    let inserted = false;

    if (altIndex !== -1) {
      // Closest preceding anchor in alternate that is already placed.
      for (let j = altIndex - 1; j >= 0; j--) {
        const candidate = alternate[j];
        if (placedSet.has(candidate)) {
          const placedIdx = placed.indexOf(candidate);
          placed.splice(placedIdx + 1, 0, missing);
          placedSet.add(missing);
          inserted = true;
          break;
        }
      }
      // Closest following anchor in alternate that is already placed.
      if (!inserted) {
        for (let j = altIndex + 1; j < alternate.length; j++) {
          const candidate = alternate[j];
          if (placedSet.has(candidate)) {
            const placedIdx = placed.indexOf(candidate);
            placed.splice(placedIdx, 0, missing);
            placedSet.add(missing);
            inserted = true;
            break;
          }
        }
      }
    }

    if (!inserted) {
      placed.push(missing);
      placedSet.add(missing);
    }
  }

  // Build actions and resolved chain.
  // Surviving actions appear in resolved-chain order; remove / remove_local
  // actions are appended afterwards (they aren't part of the chain).
  const actions: MergeAction[] = [];
  const resolvedChain: FxFingerprint[] = [];
  for (const key of placed) {
    const action = actionByKey.get(key)!;
    actions.push(action);
    resolvedChain.push(getResolvedFx(action));
  }
  for (const [key, action] of actionByKey) {
    if (placedSet.has(key)) continue;
    actions.push(action);
  }

  const hasConflicts = actions.some((a) => a.type === "conflict");

  return { actions, hasConflicts, resolvedChain };
}

function resolveActionForKey(
  key: string,
  oldFx: FxFingerprint | undefined,
  newFx: FxFingerprint | undefined,
  localFx: FxFingerprint | undefined
): MergeAction {
  // Present in all three — the common case.
  if (oldFx && newFx && localFx) {
    const baseChanged = oldFx.stateHash !== newFx.stateHash;
    const localChanged = oldFx.stateHash !== localFx.stateHash;

    if (!baseChanged && !localChanged) {
      return { type: "keep_base", fx: oldFx };
    }
    if (baseChanged && !localChanged) {
      return { type: "use_new_base", fx: newFx };
    }
    if (!baseChanged && localChanged) {
      return { type: "keep_local", fx: localFx };
    }
    if (newFx.stateHash === localFx.stateHash) {
      // Both changed the same way.
      return { type: "keep_local", fx: localFx };
    }
    return {
      type: "conflict",
      local: localFx,
      base: newFx,
      reason: "Modified in both base and local",
    };
  }

  // Present in old + new, removed locally.
  if (oldFx && newFx && !localFx) {
    if (oldFx.stateHash === newFx.stateHash) {
      return { type: "remove_local", fx: newFx };
    }
    return {
      type: "conflict",
      local: oldFx, // stand-in: local "chose" to remove
      base: newFx,
      reason: "Modified in base but removed locally",
    };
  }

  // Present in old + local, removed upstream.
  if (oldFx && !newFx && localFx) {
    if (oldFx.stateHash === localFx.stateHash) {
      return {
        type: "remove",
        pluginName: localFx.pluginName,
        pluginType: localFx.pluginType,
        slotId: localFx.slotId,
      };
    }
    return {
      type: "conflict",
      local: localFx,
      base: oldFx,
      reason: "Removed in base but modified locally",
    };
  }

  // Added in base only.
  if (!oldFx && newFx && !localFx) {
    return { type: "add_base", fx: newFx };
  }

  // Added in both base and local.
  if (!oldFx && newFx && localFx) {
    if (newFx.stateHash === localFx.stateHash) {
      return { type: "keep_local", fx: localFx };
    }
    return {
      type: "conflict",
      local: localFx,
      base: newFx,
      reason: "Added in both base and local with different state",
    };
  }

  // Purely local addition.
  if (!oldFx && !newFx && localFx) {
    return { type: "add_local", fx: localFx };
  }

  // Removed by both (was in old, gone from new and local).
  if (oldFx && !newFx && !localFx) {
    return {
      type: "remove",
      pluginName: oldFx.pluginName,
      pluginType: oldFx.pluginType,
      slotId: oldFx.slotId,
    };
  }

  // Unreachable: key must be in at least one of old / new / local.
  throw new Error(`threeWayMerge: slot ${key} present in none of old/new/local`);
}

function getResolvedFx(action: MergeAction): FxFingerprint {
  switch (action.type) {
    case "keep_base":
    case "use_new_base":
    case "keep_local":
    case "add_local":
    case "add_base":
      return action.fx;
    case "conflict":
      return action.local; // safe default: keep local version
    case "remove":
    case "remove_local":
      throw new Error("Cannot get resolved FX for a remove action");
  }
}
