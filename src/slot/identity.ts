import type { FxFingerprint } from "../snapshot/types.js";

/**
 * Slugify a plugin name into a human-readable slot ID.
 * "AU: T-De-Esser 2 (Techivation)" -> "t-de-esser-2"
 * "AU: kHs Snap Heap (Kilohearts)" -> "khs-snap-heap"
 *
 * Strips the "AU: " / "VST: " prefix and manufacturer suffix in parens,
 * then lowercases and replaces non-alphanumeric runs with hyphens.
 */
export function slugifyPluginName(pluginName: string): string {
  let name = pluginName;

  // Strip plugin format prefix (e.g., "AU: ", "VST: ", "VST3: ", "JS: ", "DX: ")
  name = name.replace(/^[A-Z0-9]+:\s*/, "");

  // Strip manufacturer suffix in parentheses at the end
  name = name.replace(/\s*\([^)]*\)\s*$/, "");

  // Lowercase, replace non-alphanumeric with hyphens, collapse multiple hyphens
  name = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return name || "unknown";
}

/**
 * Generate a unique slot ID from a plugin name.
 * If the slug already exists in existingIds, appends -2, -3, etc.
 */
export function generateSlotId(
  pluginName: string,
  existingIds: Set<string>
): string {
  const baseSlug = slugifyPluginName(pluginName);

  if (!existingIds.has(baseSlug)) {
    return baseSlug;
  }

  let counter = 2;
  while (existingIds.has(`${baseSlug}-${counter}`)) {
    counter++;
  }
  return `${baseSlug}-${counter}`;
}

/**
 * Auto-assign slot IDs to a chain of fingerprints.
 * Each fingerprint gets a unique slotId based on its plugin name.
 */
export function assignSlotIds(chain: FxFingerprint[]): FxFingerprint[] {
  const existingIds = new Set<string>();

  return chain.map((fx) => {
    const slotId = generateSlotId(fx.pluginName, existingIds);
    existingIds.add(slotId);
    return { ...fx, slotId };
  });
}
