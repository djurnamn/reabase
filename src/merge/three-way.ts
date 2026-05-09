import type { FxFingerprint, ParameterValue } from "../snapshot/types.js";
import { hashParameters } from "../snapshot/capture.js";
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
 * Two fingerprints have the "same state" iff their parameter hash AND their
 * bypass flag both match. Bypass is normalised so undefined and false read
 * as the same — slots without a bypass flag are active.
 */
function fxStateEqual(a: FxFingerprint, b: FxFingerprint): boolean {
  if (a.stateHash !== b.stateHash) return false;
  return (a.bypassed === true) === (b.bypassed === true);
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
    const baseChanged = !fxStateEqual(oldFx, newFx);
    const localChanged = !fxStateEqual(oldFx, localFx);

    if (!baseChanged && !localChanged) {
      return { type: "keep_base", fx: oldFx };
    }
    if (baseChanged && !localChanged) {
      return { type: "use_new_base", fx: newFx };
    }
    if (!baseChanged && localChanged) {
      return { type: "keep_local", fx: localFx };
    }
    if (fxStateEqual(newFx, localFx)) {
      // Both changed the same way.
      return { type: "keep_local", fx: localFx };
    }
    // Both diverged from the snapshot AND from each other. Try a
    // per-parameter three-way merge that also folds disjoint bypass edits:
    // if local and upstream edited disjoint params (and at most one side
    // toggled bypass), fold them together instead of declaring a
    // plugin-level conflict (Bug 2 + bypass round-trip).
    const merged = tryMergeParams(oldFx, newFx, localFx);
    if (merged) {
      return { type: "merge_params", fx: merged };
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
    if (fxStateEqual(oldFx, newFx)) {
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
    if (fxStateEqual(oldFx, localFx)) {
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
    if (fxStateEqual(newFx, localFx)) {
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
    case "merge_params":
      return action.fx;
    case "conflict":
      return action.local; // safe default: keep local version
    case "remove":
    case "remove_local":
      throw new Error("Cannot get resolved FX for a remove action");
  }
}

/**
 * Per-parameter three-way merge for a single plugin.
 * Returns a merged fingerprint if every diverging parameter resolves
 * cleanly (one side edited, the other didn't), or null if at least one
 * parameter has a real three-way disagreement.
 *
 * The merged fingerprint inherits local's stateBlob: Lua applies the
 * merged params on top of the local plugin via TrackFX_SetParam, so the
 * blob never needs to round-trip through serialization.
 *
 * Bypass is folded in alongside parameters: a one-sided bypass toggle is
 * absorbed cleanly; a two-sided disagreement (snapshot=off, local=on,
 * new=off-but-different-meaning) is treated as a real conflict.
 */
function tryMergeParams(
  oldFx: FxFingerprint,
  newFx: FxFingerprint,
  localFx: FxFingerprint
): FxFingerprint | null {
  // Three-way merge of bypass first. Either side toggling is fine; both
  // sides setting different end-states is a conflict (rare in practice
  // since bypass is binary, but guarded for completeness).
  const oldBypass = oldFx.bypassed === true;
  const newBypass = newFx.bypassed === true;
  const localBypass = localFx.bypassed === true;
  const baseBypassChanged = oldBypass !== newBypass;
  const localBypassChanged = oldBypass !== localBypass;
  let mergedBypass: boolean;
  if (baseBypassChanged && localBypassChanged && newBypass !== localBypass) {
    return null;
  } else if (baseBypassChanged && !localBypassChanged) {
    mergedBypass = newBypass;
  } else if (!baseBypassChanged && localBypassChanged) {
    mergedBypass = localBypass;
  } else {
    mergedBypass = oldBypass;
  }

  const allKeys = new Set<string>([
    ...Object.keys(oldFx.parameters),
    ...Object.keys(newFx.parameters),
    ...Object.keys(localFx.parameters),
  ]);

  // No per-parameter data available — divergent stateHashes must be coming
  // from something we can't see (e.g., stateBlob). If only bypass differs,
  // we can still emit a merged fingerprint with the merged bypass.
  if (allKeys.size === 0) {
    if (oldFx.stateHash === newFx.stateHash && oldFx.stateHash === localFx.stateHash) {
      return {
        ...localFx,
        ...(mergedBypass ? { bypassed: true } : { bypassed: undefined }),
      };
    }
    return null;
  }

  const merged: Record<string, ParameterValue> = {};
  for (const key of allKeys) {
    const oldP = oldFx.parameters[key];
    const newP = newFx.parameters[key];
    const localP = localFx.parameters[key];

    if (newP === undefined && localP === undefined) continue;
    if (newP === undefined) {
      merged[key] = localP!;
      continue;
    }
    if (localP === undefined) {
      merged[key] = newP;
      continue;
    }

    if (newP.value === localP.value) {
      merged[key] = newP;
      continue;
    }

    if (oldP === undefined) {
      // Both sides added the same param with different values.
      return null;
    }

    const baseChanged = oldP.value !== newP.value;
    const localChanged = oldP.value !== localP.value;

    if (baseChanged && !localChanged) {
      merged[key] = newP;
      continue;
    }
    if (!baseChanged && localChanged) {
      merged[key] = localP;
      continue;
    }
    if (!baseChanged && !localChanged) {
      merged[key] = oldP;
      continue;
    }
    // Both edited the same param to different values — real conflict.
    return null;
  }

  return {
    ...localFx,
    parameters: merged,
    stateHash: hashParameters(merged),
    ...(mergedBypass ? { bypassed: true } : { bypassed: undefined }),
  };
}
