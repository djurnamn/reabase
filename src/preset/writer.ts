import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { PresetDefinition } from "./types.js";
import type { FxFingerprint } from "../snapshot/types.js";
import { serializePresetFxChain } from "./rfxchain.js";
import { hashParameters } from "../snapshot/capture.js";

/**
 * Regenerate a root preset's JSON preset file and plugins list from current fingerprints.
 */
export function updateRootPreset(
  presetsDirectory: string,
  definition: PresetDefinition,
  ownedFingerprints: FxFingerprint[]
): void {
  if (!definition.fxChainFile) {
    throw new Error(`Root preset '${definition.name}' has no fxChainFile`);
  }

  const presetFilePath = resolve(presetsDirectory, definition.fxChainFile);

  // Regenerate JSON preset from fingerprints
  const presetContent = serializePresetFxChain(ownedFingerprints);
  writeFileSync(presetFilePath, presetContent, "utf-8");

  // Update plugins list in YAML
  const safeFilename = definition.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);

  const yamlDefinition: Record<string, unknown> = {
    name: definition.name,
  };
  if (definition.description) {
    yamlDefinition.description = definition.description;
  }
  yamlDefinition.fxChainFile = definition.fxChainFile;
  yamlDefinition.plugins = ownedFingerprints.map((fp) => ({ id: fp.slotId }));

  writeFileSync(yamlPath, YAML.stringify(yamlDefinition), "utf-8");
}

/**
 * Update a child preset's overrides and additions based on current fingerprints.
 *
 * For each owned plugin:
 * - If slotId exists in parent chain and state differs: write param file + override entry
 * - If slotId exists in parent chain and state matches: remove override (inherits naturally)
 * - If slotId not in parent chain: add entry + include in child preset file
 */
export function updateChildPreset(
  presetsDirectory: string,
  definition: PresetDefinition,
  parentChain: FxFingerprint[],
  ownedFingerprints: FxFingerprint[]
): void {
  const fxDirectory = join(presetsDirectory, "fx");
  mkdirSync(fxDirectory, { recursive: true });

  const parentSlotIds = new Set(parentChain.map((fx) => fx.slotId));
  const overrides: Record<string, { stateFile: string }> = {};
  const additions: FxFingerprint[] = [];
  const addEntries: Array<{ id: string; after?: string }> = [];

  for (const fp of ownedFingerprints) {
    if (parentSlotIds.has(fp.slotId)) {
      // Plugin exists in parent chain — check if state differs
      const parentFp = parentChain.find((pfx) => pfx.slotId === fp.slotId);
      if (parentFp && parentFp.stateHash !== fp.stateHash) {
        // State differs — write parameter file and add override
        const stateFileName = `fx/${definition.name}_${fp.slotId}.json`;
        const stateFilePath = resolve(presetsDirectory, stateFileName);
        writeFileSync(stateFilePath, JSON.stringify(fp.parameters, null, 2), "utf-8");
        overrides[fp.slotId] = { stateFile: stateFileName };
      }
      // If state matches, do nothing — inherits naturally (no override needed)
    } else {
      // Plugin not in parent chain — it's an addition
      additions.push(fp);

      // Determine insertion point: find the previous plugin in the full chain
      const ownedIndex = ownedFingerprints.indexOf(fp);
      if (ownedIndex > 0) {
        const previousSlotId = ownedFingerprints[ownedIndex - 1].slotId;
        addEntries.push({ id: fp.slotId, after: previousSlotId });
      } else {
        addEntries.push({ id: fp.slotId });
      }
    }
  }

  // Build YAML definition
  const safeFilename = definition.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);

  const yamlDefinition: Record<string, unknown> = {
    name: definition.name,
  };
  if (definition.description) {
    yamlDefinition.description = definition.description;
  }
  if (definition.extends) {
    yamlDefinition.extends = definition.extends;
  }

  if (Object.keys(overrides).length > 0) {
    yamlDefinition.override = overrides;
  }

  if (definition.remove && definition.remove.length > 0) {
    yamlDefinition.remove = definition.remove;
  }

  if (additions.length > 0) {
    // Write JSON preset for added plugins
    const presetRelPath = `fx/${safeFilename}.json`;
    const presetAbsPath = resolve(presetsDirectory, presetRelPath);
    const presetContent = serializePresetFxChain(additions);
    writeFileSync(presetAbsPath, presetContent, "utf-8");

    yamlDefinition.fxChainFile = presetRelPath;
    yamlDefinition.add = addEntries;
  }
  // When additions.length === 0, old add/fxChainFile entries are intentionally
  // dropped — the user released those plugins from this preset level.

  writeFileSync(yamlPath, YAML.stringify(yamlDefinition), "utf-8");
}
