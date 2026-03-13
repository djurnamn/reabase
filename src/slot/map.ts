import type { FxFingerprint } from "../snapshot/types.js";
import { generateSlotId } from "./identity.js";

export interface SlotMapEntry {
  pluginType: string;
  pluginName: string;
  stateHash: string;
}

export type SlotMap = Record<string, SlotMapEntry>;

/**
 * Build a slot map from a fingerprint chain.
 */
export function buildSlotMap(chain: FxFingerprint[]): SlotMap {
  const map: SlotMap = {};
  for (const fx of chain) {
    map[fx.slotId] = {
      pluginType: fx.pluginType,
      pluginName: fx.pluginName,
      stateHash: fx.stateHash,
    };
  }
  return map;
}

/**
 * Serialize slot map to JSON string for P_EXT storage.
 */
export function serializeSlotMap(map: SlotMap): string {
  return JSON.stringify(map);
}

/**
 * Parse slot map from P_EXT JSON string.
 */
export function parseSlotMap(json: string): SlotMap | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as SlotMap;
  } catch {
    return null;
  }
}

/**
 * Reassign slotIds on a captured chain using a stored slot map.
 *
 * Algorithm:
 * 1. Exact match (identity + stateHash) -> assign stored slotId
 * 2. Identity-only match (TYPE::NAME same, hash differs) -> assign by closest position
 * 3. No match -> keep auto-generated slotId (unmanaged local plugin)
 */
export function resolveSlotIds(
  chain: FxFingerprint[],
  slotMap: SlotMap
): FxFingerprint[] {
  const usedSlotIds = new Set<string>();
  const result: FxFingerprint[] = new Array(chain.length);

  // Build ordered entries from slot map for position-based matching
  const slotEntries = Object.entries(slotMap);

  // Pass 1: exact match (identity + stateHash)
  const unmatched: number[] = [];
  for (let i = 0; i < chain.length; i++) {
    const fx = chain[i];
    let matched = false;

    for (const [slotId, entry] of slotEntries) {
      if (usedSlotIds.has(slotId)) continue;
      if (
        entry.pluginType === fx.pluginType &&
        entry.pluginName === fx.pluginName &&
        entry.stateHash === fx.stateHash
      ) {
        result[i] = { ...fx, slotId };
        usedSlotIds.add(slotId);
        matched = true;
        break;
      }
    }

    if (!matched) {
      unmatched.push(i);
    }
  }

  // Pass 2: identity-only match for remaining unmatched
  const stillUnmatched: number[] = [];
  for (const i of unmatched) {
    const fx = chain[i];

    // Find all slot map entries with the same identity that haven't been used
    const candidates: Array<{ slotId: string; mapIndex: number }> = [];
    for (let j = 0; j < slotEntries.length; j++) {
      const [slotId, entry] = slotEntries[j];
      if (usedSlotIds.has(slotId)) continue;
      if (
        entry.pluginType === fx.pluginType &&
        entry.pluginName === fx.pluginName
      ) {
        candidates.push({ slotId, mapIndex: j });
      }
    }

    if (candidates.length > 0) {
      // Pick the closest by position
      const closest = candidates.reduce((best, candidate) =>
        Math.abs(candidate.mapIndex - i) < Math.abs(best.mapIndex - i)
          ? candidate
          : best
      );
      result[i] = { ...fx, slotId: closest.slotId };
      usedSlotIds.add(closest.slotId);
    } else {
      stillUnmatched.push(i);
    }
  }

  // Pass 3: no match — keep auto-generated slotId, ensuring uniqueness
  const existingIds = new Set(
    result.filter(Boolean).map((fx) => fx.slotId)
  );
  for (const i of stillUnmatched) {
    const fx = chain[i];
    const slotId = existingIds.has(fx.slotId)
      ? generateSlotId(fx.pluginName, existingIds)
      : fx.slotId;
    existingIds.add(slotId);
    result[i] = { ...fx, slotId };
  }

  return result;
}
