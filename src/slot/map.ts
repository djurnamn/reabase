import type { FxFingerprint } from "../snapshot/types.js";
import { generateSlotId } from "./identity.js";

export interface SlotMapEntry {
  pluginType: string;
  pluginName: string;
  stateHash: string;
  /** Optional track-local label. Surfaces as `fp.displayName` for plugins
   *  without a preset-provided label (e.g. local additions or for renaming
   *  what the UI shows on a per-track basis). Set via the `rename-slot`
   *  bridge command; backwards compatible — slot maps without this field
   *  read fine. */
  label?: string;
}

export type SlotMap = Record<string, SlotMapEntry>;

/**
 * Build a slot map from a fingerprint chain. Preserves any existing label
 * on the fingerprint via `displayName` so renaming round-trips through
 * subsequent capture/serialize cycles.
 */
export function buildSlotMap(chain: FxFingerprint[]): SlotMap {
  const map: SlotMap = {};
  for (const fx of chain) {
    const entry: SlotMapEntry = {
      pluginType: fx.pluginType,
      pluginName: fx.pluginName,
      stateHash: fx.stateHash,
    };
    if (fx.displayName && fx.displayName.length > 0) {
      entry.label = fx.displayName;
    }
    map[fx.slotId] = entry;
  }
  return map;
}

/**
 * Serialize slot map for P_EXT storage.
 * Base64-encodes the JSON to avoid corruption from RPP parser
 * splitting the value at spaces.
 */
export function serializeSlotMap(map: SlotMap): string {
  return Buffer.from(JSON.stringify(map), "utf-8").toString("base64");
}

/**
 * Parse slot map from P_EXT storage.
 * Accepts both base64-encoded (current) and raw JSON (legacy) formats.
 */
export function parseSlotMap(value: string): SlotMap | null {
  try {
    // Try base64 decode first (current format)
    const decoded = Buffer.from(value, "base64").toString("utf-8");
    if (decoded.startsWith("{")) {
      const parsed = JSON.parse(decoded);
      if (typeof parsed === "object" && parsed !== null) return parsed as SlotMap;
    }
  } catch {
    // Fall through to raw JSON
  }
  try {
    // Legacy: raw JSON (for backward compatibility)
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) return parsed as SlotMap;
  } catch {
    // Neither format worked
  }
  return null;
}

/**
 * Reassign slotIds on a captured chain using a stored slot map.
 *
 * Algorithm:
 * 1. Exact match (identity + stateHash) -> assign stored slotId
 * 2. Identity-only match (TYPE::NAME same, hash differs) -> pair the Nth
 *    chain occurrence of that identity with the Nth unused snapshot occurrence.
 *    Stable under independent state tweaks of duplicate-identity plugins:
 *    tweaking parameters does not move a plugin's position in the chain, so
 *    "the second filter" stays "the second filter."
 * 3. No match -> keep auto-generated slotId (unmanaged local plugin)
 */
export function resolveSlotIds(
  chain: FxFingerprint[],
  slotMap: SlotMap
): FxFingerprint[] {
  const usedSlotIds = new Set<string>();
  const result: FxFingerprint[] = new Array(chain.length);

  // slotEntries iteration order is insertion order = snapshot chain order
  // (buildSlotMap inserts in chain order).
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
        result[i] = applyMapEntry(fx, slotId, entry);
        usedSlotIds.add(slotId);
        matched = true;
        break;
      }
    }

    if (!matched) {
      unmatched.push(i);
    }
  }

  // Pass 2: identity-only match by Nth-occurrence pairing.
  // Group remaining unused slot ids by identity, preserving snapshot chain order
  // (slotEntries is already in that order). Then iterate unmatched chain
  // positions in chain order and shift one slot id off each identity's queue.
  const unusedByIdentity = new Map<string, string[]>();
  for (const [slotId, entry] of slotEntries) {
    if (usedSlotIds.has(slotId)) continue;
    const key = `${entry.pluginType}::${entry.pluginName}`;
    let queue = unusedByIdentity.get(key);
    if (!queue) {
      queue = [];
      unusedByIdentity.set(key, queue);
    }
    queue.push(slotId);
  }

  const stillUnmatched: number[] = [];
  for (const i of unmatched) {
    const fx = chain[i];
    const key = `${fx.pluginType}::${fx.pluginName}`;
    const queue = unusedByIdentity.get(key);
    if (queue && queue.length > 0) {
      const slotId = queue.shift()!;
      result[i] = applyMapEntry(fx, slotId, slotMap[slotId]);
      usedSlotIds.add(slotId);
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

/**
 * Apply a slot map entry to a captured fingerprint: assigns the stored
 * slotId and surfaces any stored `label` as `displayName`. A captured
 * fingerprint already carrying a `displayName` (set by upstream resolver
 * logic) keeps the captured value if the slot map has no override.
 */
function applyMapEntry(
  fx: FxFingerprint,
  slotId: string,
  entry: SlotMapEntry
): FxFingerprint {
  const result: FxFingerprint = { ...fx, slotId };
  if (entry.label && entry.label.length > 0) {
    result.displayName = entry.label;
  }
  return result;
}
