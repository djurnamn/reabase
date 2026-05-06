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
 * For each owned slot:
 * - If slotId exists in parent chain and state differs: write param file + override entry
 * - If slotId exists in parent chain and state matches: remove override (inherits naturally)
 * - If slotId not in parent chain: add entry + include in child preset file
 *
 * Add entries are emitted in the order they appear in the track's full chain,
 * with anchors picked so the resolver reproduces that order exactly:
 * - Closest preceding "known" slot (parent slot, or earlier-emitted addition) → `after:`.
 * - Otherwise, closest following parent slot → `before:`.
 * - Otherwise (no anchor) → appended at end.
 *
 * `fullChain` is the full track chain (in order) — needed to figure out where
 * each owned addition sits relative to parent slots, which is how `before:`
 * gets generated when an owned plugin is positioned ahead of any parent slot.
 */
export function updateChildPreset(
  presetsDirectory: string,
  definition: PresetDefinition,
  parentChain: FxFingerprint[],
  fullChain: FxFingerprint[],
  ownedSlotIds: string[]
): void {
  const fxDirectory = join(presetsDirectory, "fx");
  mkdirSync(fxDirectory, { recursive: true });

  const parentSlotIdSet = new Set(parentChain.map((fx) => fx.slotId));
  const ownedSet = new Set(ownedSlotIds);
  const overrides: Record<string, { stateFile: string }> = {};
  const additions: FxFingerprint[] = [];
  const addEntries: Array<{ id: string; after?: string; before?: string }> = [];

  for (let i = 0; i < fullChain.length; i++) {
    const fp = fullChain[i];
    if (!ownedSet.has(fp.slotId)) continue;

    if (parentSlotIdSet.has(fp.slotId)) {
      // Owned slot is inherited from parent — check whether to write an override.
      const parentFp = parentChain.find((pfx) => pfx.slotId === fp.slotId);
      if (parentFp && parentFp.stateHash !== fp.stateHash) {
        const stateFileName = `fx/${definition.name}_${fp.slotId}.json`;
        const stateFilePath = resolve(presetsDirectory, stateFileName);
        writeFileSync(stateFilePath, JSON.stringify(fp.parameters, null, 2), "utf-8");
        overrides[fp.slotId] = { stateFile: stateFileName };
      }
      // State matches → inherit naturally, no override.
      continue;
    }

    // Owned slot is an addition. Pick the anchor that will reproduce its
    // current chain position when the resolver replays the YAML.
    additions.push(fp);

    // "Known" slots at this point in the YAML walk: parent slots plus any
    // additions we've already emitted. Future additions aren't known yet,
    // so they can't serve as anchors here.
    const knownAtThisPoint = new Set<string>([
      ...parentSlotIdSet,
      ...addEntries.map((e) => e.id),
    ]);

    const entry: { id: string; after?: string; before?: string } = { id: fp.slotId };

    for (let j = i - 1; j >= 0; j--) {
      if (knownAtThisPoint.has(fullChain[j].slotId)) {
        entry.after = fullChain[j].slotId;
        break;
      }
    }
    if (!entry.after) {
      for (let j = i + 1; j < fullChain.length; j++) {
        if (knownAtThisPoint.has(fullChain[j].slotId)) {
          entry.before = fullChain[j].slotId;
          break;
        }
      }
    }

    addEntries.push(entry);
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
