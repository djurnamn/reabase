import { createHash } from "node:crypto";
import type { RppNode } from "../parser/types.js";
import {
  getFxChain,
  getFxPlugins,
  getFxPluginName,
  getFxPluginType,
  getFxStateBlob,
} from "../parser/helpers.js";
import type { FxFingerprint, ParameterValue } from "./types.js";
import { generateUniqueSlotId } from "../slot/identity.js";

/**
 * Capture the current FX chain structure of a track as an ordered list of fingerprints.
 * Returns structural fingerprints with empty parameters and stateHash.
 * Parameters come from Lua via TrackFX_GetParam — use enrichWithParameters() to merge them in.
 */
export function captureFxChain(track: RppNode): FxFingerprint[] {
  const fxChain = getFxChain(track);
  if (!fxChain) return [];

  const plugins = getFxPlugins(fxChain);
  const existingIds = new Set<string>();

  return plugins.map((plugin) => {
    const pluginName = getFxPluginName(plugin) ?? "unknown";
    const pluginType = getFxPluginType(plugin);
    const slotId = generateUniqueSlotId(pluginName, existingIds);
    existingIds.add(slotId);
    // Capture additional opening-line params (AU component IDs, VST dll path, etc.)
    const pluginParams = plugin.params.length > 1 ? plugin.params.slice(1) : undefined;
    // Capture state blob for full VST/VST3 state restoration
    const blob = getFxStateBlob(plugin);
    return {
      pluginName,
      pluginType,
      stateHash: "",
      slotId,
      pluginParams,
      parameters: {},
      stateBlob: blob || undefined,
    };
  });
}

/**
 * Round a parameter value to 6 decimal places for stable comparison.
 * REAPER uses 32-bit floats internally but exposes 64-bit doubles via the API,
 * so values like 0.4 come back as 0.40000000596046. Rounding to 6 places
 * normalizes these to match across instances.
 */
function roundParam(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Compute a SHA-256 hash from a parameter map.
 * Sorts keys numerically and concatenates key:value pairs for deterministic hashing.
 * Values are rounded to 6 decimal places for float stability.
 */
export function hashParameters(params: Record<string, ParameterValue>): string {
  const keys = Object.keys(params).sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0) return "";
  const content = keys.map((k) => `${k}:${roundParam(params[k].value)}`).join("|");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Merge Lua-captured parameters into structural fingerprints.
 * Computes stateHash from the parameter data.
 *
 * @param chain - Structural fingerprints from captureFxChain (or parsed preset)
 * @param parameterData - Array of parameter maps, one per FX (from Lua's TrackFX_GetParam)
 */
export function enrichWithParameters(
  chain: FxFingerprint[],
  parameterData: Record<string, ParameterValue>[]
): FxFingerprint[] {
  return chain.map((fx, i) => {
    const params = parameterData[i] ?? {};
    return {
      ...fx,
      parameters: params,
      stateHash: hashParameters(params),
    };
  });
}
