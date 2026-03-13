import type { FxFingerprint } from "../snapshot/types.js";
import type { MergeAction, MergeResult } from "./types.js";

/**
 * Build a lookup: slotId -> FxFingerprint
 */
function buildLookup(
  chain: FxFingerprint[]
): Map<string, FxFingerprint> {
  const lookup = new Map<string, FxFingerprint>();
  for (const fx of chain) {
    lookup.set(fx.slotId, fx);
  }
  return lookup;
}

/**
 * Get ordered keys from a chain (slotIds in chain order).
 */
function getOrderedKeys(chain: FxFingerprint[]): string[] {
  return chain.map((fx) => fx.slotId);
}

/**
 * Three-way merge of FX chains.
 *
 * @param oldBase - The snapshot of what was last applied (common ancestor)
 * @param newBase - The updated preset definition (upstream changes)
 * @param local - The current track state (local changes)
 * @returns MergeResult with actions and resolved chain
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
  const newKeys = getOrderedKeys(newBase);
  const localKeys = getOrderedKeys(local);

  const actions: MergeAction[] = [];
  const resolvedChain: FxFingerprint[] = [];

  // Process keys in new base order first (for ordering),
  // then append locally-added keys
  const processedKeys = new Set<string>();

  // 1. Walk through new base order — these define the base ordering
  for (const key of newKeys) {
    if (processedKeys.has(key)) continue;
    processedKeys.add(key);

    const oldFx = oldLookup.get(key);
    const newFx = newLookup.get(key)!;
    const localFx = localLookup.get(key);

    const action = resolveAction(key, oldFx, newFx, localFx);
    actions.push(action);
    if (action.type !== "remove") {
      resolvedChain.push(getResolvedFx(action));
    }
  }

  // 2. Walk through local keys — pick up locally-added FX not in new base
  for (const key of localKeys) {
    if (processedKeys.has(key)) continue;
    processedKeys.add(key);

    const oldFx = oldLookup.get(key);
    const localFx = localLookup.get(key)!;

    if (oldFx) {
      // Was in old base, not in new base (removed upstream), but still in local
      if (oldFx.stateHash === localFx.stateHash) {
        // Local didn't modify it — accept the upstream removal
        actions.push({
          type: "remove",
          pluginName: localFx.pluginName,
          pluginType: localFx.pluginType,
          slotId: localFx.slotId,
        });
      } else {
        // Local modified it but upstream removed it — conflict
        actions.push({
          type: "conflict",
          local: localFx,
          base: oldFx,
          reason: "Removed in base but modified locally",
        });
        // Include local version in resolved chain (safe default)
        resolvedChain.push(localFx);
      }
    } else {
      // Not in old base and not in new base — purely local addition
      actions.push({ type: "add_local", fx: localFx });
      resolvedChain.push(localFx);
    }
  }

  // 3. Handle keys in old base that are in neither new base nor local (removed by both)
  for (const key of oldKeys) {
    if (processedKeys.has(key)) continue;
    processedKeys.add(key);

    const oldFx = oldLookup.get(key)!;
    actions.push({
      type: "remove",
      pluginName: oldFx.pluginName,
      pluginType: oldFx.pluginType,
      slotId: oldFx.slotId,
    });
  }

  const hasConflicts = actions.some((a) => a.type === "conflict");

  return { actions, hasConflicts, resolvedChain };
}

function resolveAction(
  key: string,
  oldFx: FxFingerprint | undefined,
  newFx: FxFingerprint | undefined,
  localFx: FxFingerprint | undefined
): MergeAction {
  // FX is in new base
  if (newFx && !oldFx && !localFx) {
    // New in base, not in old or local — base addition
    return { type: "add_base", fx: newFx };
  }

  if (newFx && oldFx && !localFx) {
    // Was in old base, is in new base, but removed locally
    if (oldFx.stateHash === newFx.stateHash) {
      // Base didn't change it — accept local removal
      return {
        type: "remove",
        pluginName: newFx.pluginName,
        pluginType: newFx.pluginType,
        slotId: newFx.slotId,
      };
    } else {
      // Base changed it but local removed it — conflict
      return {
        type: "conflict",
        local: oldFx, // "local" chose to remove, use old as stand-in
        base: newFx,
        reason: "Modified in base but removed locally",
      };
    }
  }

  if (newFx && !oldFx && localFx) {
    // New in both base and local (both added the same plugin)
    if (newFx.stateHash === localFx.stateHash) {
      return { type: "keep_local", fx: localFx };
    }
    // Both added same plugin with different state — conflict
    return {
      type: "conflict",
      local: localFx,
      base: newFx,
      reason: "Added in both base and local with different state",
    };
  }

  if (newFx && oldFx && localFx) {
    // Present in all three — the common case
    const baseChanged = oldFx.stateHash !== newFx.stateHash;
    const localChanged = oldFx.stateHash !== localFx.stateHash;

    if (!baseChanged && !localChanged) {
      // Nobody changed it
      return { type: "keep_base", fx: oldFx };
    }
    if (baseChanged && !localChanged) {
      // Only base changed — take new base
      return { type: "use_new_base", fx: newFx };
    }
    if (!baseChanged && localChanged) {
      // Only local changed — keep local
      return { type: "keep_local", fx: localFx };
    }
    // Both changed
    if (newFx.stateHash === localFx.stateHash) {
      // Both changed the same way — no conflict
      return { type: "keep_local", fx: localFx };
    }
    // Both changed differently — conflict
    return {
      type: "conflict",
      local: localFx,
      base: newFx,
      reason: "Modified in both base and local",
    };
  }

  // Shouldn't reach here given we enter from newKeys iteration,
  // but handle gracefully
  if (newFx) {
    return { type: "add_base", fx: newFx };
  }

  return {
    type: "remove",
    pluginName: "unknown",
    pluginType: "unknown",
    slotId: key,
  };
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
      throw new Error("Cannot get resolved FX for a remove action");
  }
}
