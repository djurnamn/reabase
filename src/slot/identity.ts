import { randomBytes } from "node:crypto";
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
 * Generate a deterministic slot ID from a plugin name.
 * Used by the resolver to assign stable IDs for presets without explicit
 * plugins lists. If the slug already exists in existingIds, appends -2, -3, etc.
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
 * Generate a unique slot ID with a random suffix.
 * Used by captureFxChain to give each plugin instance a globally unique identity.
 * Format: "plugin-name-a3f2" (slug + 4-char hex).
 */
export function generateUniqueSlotId(
  pluginName: string,
  existingIds: Set<string>
): string {
  const baseSlug = slugifyPluginName(pluginName);

  // Try up to 10 times to avoid collision (effectively impossible with 4 hex chars)
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = randomBytes(2).toString("hex");
    const candidate = `${baseSlug}-${suffix}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }

  // Fallback: use longer suffix
  return `${baseSlug}-${randomBytes(4).toString("hex")}`;
}

/**
 * Auto-assign deterministic slot IDs to a chain of fingerprints.
 * Used by the resolver as a fallback for presets without plugins lists.
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
