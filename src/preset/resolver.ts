import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PresetDefinition, ResolvedPreset } from "./types.js";
import type { FxFingerprint } from "../snapshot/types.js";
import { parseRfxChain } from "./rfxchain.js";
import { hashBlob } from "../snapshot/capture.js";
import { assignSlotIds, generateSlotId } from "../slot/identity.js";

/**
 * Resolve a preset by name, walking the inheritance chain and applying overrides.
 *
 * @param name - The preset name to resolve
 * @param presets - Map of all loaded preset definitions
 * @param presetsDirectory - Path to the presets/ directory (for resolving file paths)
 */
export function resolvePreset(
  name: string,
  presets: Map<string, PresetDefinition>,
  presetsDirectory: string
): ResolvedPreset {
  const definition = presets.get(name);
  if (!definition) {
    throw new Error(`Preset '${name}' not found`);
  }

  // Build inheritance chain (root first)
  const inheritanceChain = buildInheritanceChain(name, presets);

  // Start with the root preset's FX chain
  const rootName = inheritanceChain[0];
  const rootDefinition = presets.get(rootName)!;

  let fxChain: FxFingerprint[] = [];
  if (rootDefinition.fxChainFile) {
    const rfxChainPath = resolve(presetsDirectory, rootDefinition.fxChainFile);
    const rfxChainContent = readFileSync(rfxChainPath, "utf-8");
    fxChain = parseRfxChain(rfxChainContent).map((fx) => ({
      ...fx,
      origin: rootName,
    }));
  }

  // Assign slotIds from root's plugins list if present, otherwise auto-generate
  if (rootDefinition.plugins) {
    fxChain = fxChain.map((fx, i) => ({
      ...fx,
      slotId: rootDefinition.plugins![i]?.id ?? fx.slotId,
    }));
  } else {
    fxChain = assignSlotIds(fxChain);
  }

  // Apply each level of inheritance (skip root, it's already loaded)
  for (let i = 1; i < inheritanceChain.length; i++) {
    const levelName = inheritanceChain[i];
    const levelDefinition = presets.get(levelName)!;

    // New slot-based override (keyed by slotId)
    if (levelDefinition.override) {
      fxChain = applySlotOverrides(
        fxChain,
        levelDefinition.override,
        presetsDirectory,
        levelName
      );
    }

    // Legacy overrides (keyed by TYPE::NAME)
    if (levelDefinition.overrides) {
      fxChain = applyLegacyOverrides(
        fxChain,
        levelDefinition.overrides,
        presetsDirectory,
        levelName
      );
    }

    // Remove slots by slotId
    if (levelDefinition.remove) {
      const removeSet = new Set(levelDefinition.remove);
      fxChain = fxChain.filter((fx) => !removeSet.has(fx.slotId));
    }

    // Add new slots from child's fxChainFile
    if (levelDefinition.add && levelDefinition.fxChainFile) {
      const childRfxPath = resolve(presetsDirectory, levelDefinition.fxChainFile);
      const childContent = readFileSync(childRfxPath, "utf-8");
      const childPlugins = parseRfxChain(childContent);

      // Assign slotIds from add entries
      const existingIds = new Set(fxChain.map((fx) => fx.slotId));
      const addedPlugins = childPlugins.map((fx, idx) => {
        const addEntry = levelDefinition.add![idx];
        const slotId = addEntry?.id ?? generateSlotId(fx.pluginName, existingIds);
        existingIds.add(slotId);
        return { ...fx, slotId, origin: levelName };
      });

      // Insert each added plugin at the specified position
      for (const addedPlugin of addedPlugins) {
        const addEntry = levelDefinition.add!.find((a) => a.id === addedPlugin.slotId);
        if (addEntry?.after) {
          const afterIndex = fxChain.findIndex((fx) => fx.slotId === addEntry.after);
          if (afterIndex !== -1) {
            fxChain.splice(afterIndex + 1, 0, addedPlugin);
            continue;
          }
        }
        // Default: append at end
        fxChain.push(addedPlugin);
      }
    } else if (levelDefinition.fxChainFile && !levelDefinition.add) {
      // Legacy behavior: append child's fxChainFile plugins at end
      const childRfxPath = resolve(presetsDirectory, levelDefinition.fxChainFile);
      const childContent = readFileSync(childRfxPath, "utf-8");
      const childPlugins = parseRfxChain(childContent);
      fxChain = [...fxChain, ...childPlugins];
      // Re-assign slotIds after appending to ensure uniqueness
      fxChain = assignSlotIds(fxChain);
    }
  }

  // Compute version hash from the resolved chain
  const versionInput = fxChain
    .map((fx) => `${fx.pluginType}::${fx.pluginName}::${fx.stateHash}`)
    .join("|");
  const version = createHash("sha256").update(versionInput).digest("hex").slice(0, 12);

  return {
    name,
    inheritanceChain,
    fxChain,
    version,
  };
}

/**
 * Build the inheritance chain for a preset, root-first.
 */
function buildInheritanceChain(
  name: string,
  presets: Map<string, PresetDefinition>
): string[] {
  const chain: string[] = [];
  let current: string | undefined = name;

  while (current) {
    chain.unshift(current);
    current = presets.get(current)?.extends;
  }

  return chain;
}

/**
 * Apply slot-based overrides (keyed by slotId).
 */
function applySlotOverrides(
  fxChain: FxFingerprint[],
  overrides: Record<string, { stateFile: string }>,
  presetsDirectory: string,
  originPreset: string
): FxFingerprint[] {
  return fxChain.map((fx) => {
    const override = overrides[fx.slotId];
    if (override) {
      const stateFilePath = resolve(presetsDirectory, override.stateFile);
      const newStateBlob = readFileSync(stateFilePath, "utf-8").trim();
      return {
        ...fx,
        stateBlob: newStateBlob,
        stateHash: hashBlob(newStateBlob, fx.pluginType),
        origin: originPreset,
      };
    }
    return fx;
  });
}

/**
 * Apply legacy overrides (keyed by plugin identity "TYPE::NAME").
 */
function applyLegacyOverrides(
  fxChain: FxFingerprint[],
  overrides: Record<string, { stateFile: string }>,
  presetsDirectory: string,
  originPreset: string
): FxFingerprint[] {
  return fxChain.map((fx) => {
    const identity = `${fx.pluginType}::${fx.pluginName}`;
    const override = overrides[identity];

    if (override) {
      const stateFilePath = resolve(presetsDirectory, override.stateFile);
      const newStateBlob = readFileSync(stateFilePath, "utf-8").trim();
      return {
        ...fx,
        stateBlob: newStateBlob,
        stateHash: hashBlob(newStateBlob, fx.pluginType),
        origin: originPreset,
      };
    }

    return fx;
  });
}
