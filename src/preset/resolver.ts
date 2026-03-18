import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PresetDefinition, ResolvedPreset } from "./types.js";
import type { FxFingerprint, ParameterValue } from "../snapshot/types.js";
import { parsePresetFxChain } from "./rfxchain.js";
import { hashParameters } from "../snapshot/capture.js";
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
    const presetPath = resolve(presetsDirectory, rootDefinition.fxChainFile);
    const presetContent = readFileSync(presetPath, "utf-8");
    fxChain = parsePresetFxChain(presetContent).map((fx) => ({
      ...fx,
      stateHash: hashParameters(fx.parameters),
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

    // Slot-based override (keyed by slotId)
    if (levelDefinition.override) {
      fxChain = applySlotOverrides(
        fxChain,
        levelDefinition.override,
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
      const childPresetPath = resolve(presetsDirectory, levelDefinition.fxChainFile);
      const childContent = readFileSync(childPresetPath, "utf-8");
      const childPlugins = parsePresetFxChain(childContent).map((fx) => ({
        ...fx,
        stateHash: hashParameters(fx.parameters),
      }));

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
      const childPresetPath = resolve(presetsDirectory, levelDefinition.fxChainFile);
      const childContent = readFileSync(childPresetPath, "utf-8");
      const childPlugins = parsePresetFxChain(childContent).map((fx) => ({
        ...fx,
        stateHash: hashParameters(fx.parameters),
      }));
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
 * Override files are now JSON parameter maps.
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
      const newParams: Record<string, ParameterValue> = JSON.parse(
        readFileSync(stateFilePath, "utf-8")
      );
      return {
        ...fx,
        parameters: newParams,
        stateHash: hashParameters(newParams),
        origin: originPreset,
      };
    }
    return fx;
  });
}
