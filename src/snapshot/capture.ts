import { createHash } from "node:crypto";
import type { RppNode } from "../parser/types.js";
import {
  getFxChain,
  getFxPlugins,
  getFxPluginName,
  getFxPluginType,
  getFxStateBlob,
} from "../parser/helpers.js";
import type { FxFingerprint } from "./types.js";
import { generateSlotId } from "../slot/identity.js";
import { normalizeStateBlob } from "./normalize.js";

/**
 * Capture the current FX chain state of a track as an ordered list of fingerprints.
 * Returns an empty array if the track has no FX chain.
 */
export function captureFxChain(track: RppNode): FxFingerprint[] {
  const fxChain = getFxChain(track);
  if (!fxChain) return [];

  const plugins = getFxPlugins(fxChain);
  const existingIds = new Set<string>();

  return plugins.map((plugin) => {
    const pluginName = getFxPluginName(plugin) ?? "unknown";
    const pluginType = getFxPluginType(plugin);
    const stateBlob = getFxStateBlob(plugin);
    const slotId = generateSlotId(pluginName, existingIds);
    existingIds.add(slotId);
    return {
      pluginName,
      pluginType,
      stateHash: hashBlob(stateBlob, pluginType),
      stateBlob,
      slotId,
    };
  });
}

/**
 * Compute a SHA-256 hash of a state blob's stable content.
 *
 * Delegates to the normalize module which strips non-deterministic
 * metadata based on the plugin type (AU plist wrappers, zip timestamps,
 * etc.) before hashing. See src/snapshot/normalize.ts for details.
 *
 * @param pluginType - Used to select the appropriate normalization handler.
 *   Falls back to hashing the raw blob for unknown types.
 */
export function hashBlob(blob: string, pluginType = "unknown"): string {
  const stableContent = normalizeStateBlob(blob, pluginType);
  return createHash("sha256").update(stableContent).digest("hex");
}
