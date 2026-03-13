import { join } from "node:path";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { parseRpp } from "../parser/parse.js";
import { serializeRpp, detectLineEnding } from "../parser/serialize.js";
import {
  getTracks,
  getTrackName,
  getTrackGuid,
  getExtState,
  setExtState,
} from "../parser/helpers.js";
import { captureFxChain } from "../snapshot/capture.js";
import { readSnapshot, writeSnapshot } from "../snapshot/store.js";
import { loadPresets } from "../preset/loader.js";
import { resolvePreset } from "../preset/resolver.js";
import { threeWayMerge } from "../merge/three-way.js";
import { extractRfxChainContent, serializeRfxChainFromFingerprints } from "../preset/rfxchain.js";
import { updateRootPreset, updateChildPreset } from "../preset/writer.js";
import { applyResolvedChainToTrack, replacePluginState } from "./apply.js";
import { buildSlotMap, serializeSlotMap, parseSlotMap, resolveSlotIds } from "../slot/map.js";
import YAML from "yaml";
import type { RppNode } from "../parser/types.js";
import type { FxFingerprint } from "../snapshot/types.js";
import type { MergeResult } from "../merge/types.js";

// ─── inspect ─────────────────────────────────────────────────────

export interface InspectInput {
  trackChunk: string;
}

export interface InspectOutput {
  trackName: string | undefined;
  trackGuid: string | undefined;
  preset: string | undefined;
  currentChain: FxFingerprint[];
  presets: { name: string; description?: string }[];
  /** Root-first inheritance chain, e.g., ["voice_base", "player_voice"] */
  inheritanceChain: string[];
  /** Preset's ideal resolved state (with origin set), null if no preset */
  resolvedChain: FxFingerprint[] | null;
  status:
    | "up-to-date"
    | "modified"
    | "upstream-changes"
    | "conflict"
    | "no-snapshot"
    | "unresolvable-preset"
    | "no-preset"
    | null;
  merge: MergeResult | null;
  debug?: {
    snapshotHashes: { slotId: string; stateHash: string }[];
    presetHashes: { slotId: string; stateHash: string }[];
    currentHashes: { slotId: string; stateHash: string }[];
  };
}

/**
 * Inspect a track chunk and return its status relative to the reabase presets.
 * The track chunk is the full `<TRACK ...> ... >` text from SWS GetSetObjectState.
 */
export function inspectTrack(
  trackChunk: string,
  reabasePath: string
): InspectOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const snapshotsDirectory = join(reabasePath, "snapshots");

  const presets = loadPresets(presetsDirectory);
  const presetList = [...presets.values()].map((p) => ({
    name: p.name,
    description: p.description,
  }));

  // Parse the track chunk. SWS returns the full <TRACK ...> block.
  const track = parseTrackChunk(trackChunk);
  const trackName = getTrackName(track);
  const trackGuid = getTrackGuid(track);
  const preset = getExtState(track, "reabase_preset");
  let currentChain = captureFxChain(track);

  // Resolve slotIds from stored slot map (if available)
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap) {
      currentChain = resolveSlotIds(currentChain, slotMap);
    }
  }

  if (!preset) {
    return {
      trackName,
      trackGuid,
      preset: undefined,
      currentChain,
      presets: presetList,
      inheritanceChain: [],
      resolvedChain: null,
      status: "no-preset",
      merge: null,
    };
  }

  // Try to resolve the preset
  let resolvedPreset;
  try {
    resolvedPreset = resolvePreset(preset, presets, presetsDirectory);
  } catch {
    return {
      trackName,
      trackGuid,
      preset,
      currentChain,
      presets: presetList,
      inheritanceChain: [],
      resolvedChain: null,
      status: "unresolvable-preset",
      merge: null,
    };
  }

  // Load snapshot
  const snapshotKey = (trackName ?? "unnamed").toLowerCase();
  const snapshotPath = join(snapshotsDirectory, snapshotKey + ".json");
  const snapshot = readSnapshot(snapshotPath);

  if (!snapshot) {
    // First sync — merge from empty base
    const merge = threeWayMerge([], resolvedPreset.fxChain, currentChain);
    return {
      trackName,
      trackGuid,
      preset,
      currentChain,
      presets: presetList,
      inheritanceChain: resolvedPreset.inheritanceChain,
      resolvedChain: resolvedPreset.fxChain,
      status: "no-snapshot",
      merge,
    };
  }

  // Three-way merge (still computed for sync operations)
  const merge = threeWayMerge(
    snapshot.fxChain,
    resolvedPreset.fxChain,
    currentChain
  );

  // Build debug info: hash comparison and blob format diagnostics
  const debug = {
    snapshotHashes: snapshot.fxChain.map((fx) => ({
      slotId: fx.slotId,
      stateHash: fx.stateHash.slice(0, 12),
    })),
    presetHashes: resolvedPreset.fxChain.map((fx) => ({
      slotId: fx.slotId,
      stateHash: fx.stateHash.slice(0, 12),
    })),
    currentHashes: currentChain.map((fx) => ({
      slotId: fx.slotId,
      stateHash: fx.stateHash.slice(0, 12),
    })),
  };

  // Determine status from merge actions
  const localChanged = merge.actions.some(
    (a) => a.type === "keep_local" || a.type === "add_local"
  );
  const upstreamChanged = merge.actions.some(
    (a) => a.type === "use_new_base" || a.type === "add_base" || a.type === "remove"
  );
  const hasConflicts = merge.hasConflicts;

  let status: InspectOutput["status"];
  if (hasConflicts) {
    status = "conflict";
  } else if (localChanged && upstreamChanged) {
    status = "conflict";
  } else if (localChanged) {
    status = "modified";
  } else if (upstreamChanged) {
    status = "upstream-changes";
  } else {
    status = "up-to-date";
  }

  return {
    trackName,
    trackGuid,
    preset,
    currentChain,
    presets: presetList,
    inheritanceChain: resolvedPreset.inheritanceChain,
    resolvedChain: resolvedPreset.fxChain,
    status,
    merge,
    debug,
  };
}

// ─── apply-chunk ─────────────────────────────────────────────────

export interface ApplyChunkInput {
  trackChunk: string;
  resolvedChain: FxFingerprint[];
}

export interface ApplyChunkOutput {
  modifiedChunk: string;
}

/**
 * Apply a resolved FX chain to a track chunk and return the modified chunk.
 */
export function applyChunk(input: ApplyChunkInput): ApplyChunkOutput {
  const track = parseTrackChunk(input.trackChunk);
  applyResolvedChainToTrack(track, input.resolvedChain);

  // Write slot map to P_EXT
  const slotMap = buildSlotMap(input.resolvedChain);
  setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));

  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);
  return { modifiedChunk };
}

// ─── set-preset ──────────────────────────────────────────────────

export interface SetPresetInput {
  trackChunk: string;
  preset: string;
}

export interface SetPresetOutput {
  modifiedChunk: string;
}

/**
 * Set the reabase_preset P_EXT on a track chunk and return the modified chunk.
 */
export function setPreset(input: SetPresetInput): SetPresetOutput {
  const track = parseTrackChunk(input.trackChunk);
  setExtState(track, "reabase_preset", input.preset);
  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);
  return { modifiedChunk };
}

// ─── snapshot ────────────────────────────────────────────────────

export interface SnapshotInput {
  trackChunk: string;
  preset: string;
}

export interface SnapshotOutput {
  success: boolean;
  trackName: string;
  trackGuid: string;
  modifiedChunk: string;
}

/**
 * Capture the current FX chain state and write a snapshot.
 * Used when first assigning a role to "adopt" the current state as the baseline.
 * Returns the modified chunk with slot map written to P_EXT.
 */
export function snapshotTrack(
  input: SnapshotInput,
  reabasePath: string
): SnapshotOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const snapshotsDirectory = join(reabasePath, "snapshots");

  const track = parseTrackChunk(input.trackChunk);
  const trackName = getTrackName(track) ?? "unnamed";
  const trackGuid = getTrackGuid(track) ?? "unknown";
  let currentChain = captureFxChain(track);

  // Resolve slotIds from stored slot map (if available)
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (slotMapJson) {
    const existingSlotMap = parseSlotMap(slotMapJson);
    if (existingSlotMap) {
      currentChain = resolveSlotIds(currentChain, existingSlotMap);
    }
  }

  // Resolve preset to get the version hash and determine snapshot scope
  const presets = loadPresets(presetsDirectory);
  let presetVersion = "initial";
  let snapshotChain = currentChain;
  try {
    const resolved = resolvePreset(input.preset, presets, presetsDirectory);
    presetVersion = resolved.version;
    // Filter snapshot to only include plugins in the resolved chain.
    // Plugins not in the preset appear as local additions ("add_local")
    // rather than being baked into the baseline.
    const resolvedSlotIds = new Set(resolved.fxChain.map((fx) => fx.slotId));
    snapshotChain = currentChain.filter((fx) => resolvedSlotIds.has(fx.slotId));
  } catch {
    // If preset can't be resolved, snapshot the full chain
  }

  const snapshotKey = trackName.toLowerCase();
  const snapshotPath = join(snapshotsDirectory, snapshotKey + ".json");

  writeSnapshot(snapshotPath, {
    version: 1,
    trackGuid,
    trackName,
    preset: input.preset,
    presetVersion,
    capturedAt: new Date().toISOString(),
    fxChain: snapshotChain,
  });

  // Write slot map for ALL plugins (not just snapshot) to P_EXT
  const slotMap = buildSlotMap(currentChain);
  setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));
  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);

  return { success: true, trackName, trackGuid, modifiedChunk };
}

// ─── save-preset ─────────────────────────────────────────────────

export interface SavePresetInput {
  trackChunk: string;
  presetName: string;
  /** 0-based FX indices to include. If omitted, saves entire chain with raw fidelity. */
  selectedPlugins?: number[];
  /** Parent preset name for inheritance. Selected plugins are appended to parent's chain. */
  extendsPreset?: string;
  /** If true, overwrite an existing preset with the same slug. Defaults to false. */
  overwrite?: boolean;
}

export interface SavePresetOutput {
  success: boolean;
  presetName: string;
  fxChainFile?: string;
  /** True if a preset with this slug already exists (only set when overwrite is false). */
  exists?: boolean;
}

/**
 * Create a new preset from a track's current FX chain.
 * Supports partial selection (selectedPlugins) and inheritance (extendsPreset).
 */
export function savePreset(
  input: SavePresetInput,
  reabasePath: string
): SavePresetOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const fxDirectory = join(presetsDirectory, "fx");
  const track = parseTrackChunk(input.trackChunk);

  // Sanitize preset name for filenames
  const safeFilename = input.presetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  const rfxChainRelPath = `fx/${safeFilename}.rfxchain`;
  const rfxChainAbsPath = join(presetsDirectory, rfxChainRelPath);
  const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);

  // Check for existing preset with the same slug
  if (existsSync(yamlPath) && !input.overwrite) {
    return {
      success: false,
      presetName: input.presetName,
      exists: true,
    };
  }

  // Capture fingerprints and resolve slotIds from stored slot map
  let allFingerprints = captureFxChain(track);
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap) {
      allFingerprints = resolveSlotIds(allFingerprints, slotMap);
    }
  }

  // Determine FX chain content and selected fingerprints
  let rfxContent: string | null;
  let selectedFingerprints: FxFingerprint[];

  if (input.selectedPlugins) {
    // Partial selection: capture fingerprints, filter, serialize
    selectedFingerprints = input.selectedPlugins
      .filter((i) => i >= 0 && i < allFingerprints.length)
      .map((i) => allFingerprints[i]);

    rfxContent = selectedFingerprints.length > 0
      ? serializeRfxChainFromFingerprints(selectedFingerprints)
      : null;
  } else {
    // Full chain: extract raw content for round-trip fidelity
    rfxContent = extractRfxChainContent(track);
    selectedFingerprints = allFingerprints;
  }

  // When extending with no additions, we don't need an rfxchain file
  if (!rfxContent && !input.extendsPreset) {
    throw new Error("Track has no FX chain to save as a preset");
  }

  // Ensure fx/ subdirectory exists
  mkdirSync(fxDirectory, { recursive: true });

  // Build YAML preset definition
  const presetDefinition: Record<string, unknown> = {
    name: input.presetName,
  };

  if (input.extendsPreset) {
    presetDefinition.extends = input.extendsPreset;
  }

  if (rfxContent) {
    presetDefinition.fxChainFile = rfxChainRelPath;
    writeFileSync(rfxChainAbsPath, rfxContent, "utf-8");
  }

  // Write plugins list with slot IDs (root presets only)
  if (!input.extendsPreset && selectedFingerprints.length > 0) {
    presetDefinition.plugins = selectedFingerprints.map((fp) => ({ id: fp.slotId }));
  }

  // Write add entries for child presets (proper slotIds, positioning, and origin)
  if (input.extendsPreset && selectedFingerprints.length > 0) {
    presetDefinition.add = selectedFingerprints.map((fp) => {
      const entry: { id: string; after?: string } = { id: fp.slotId };
      // Position relative to the previous plugin in the full track chain
      const trackIndex = allFingerprints.findIndex((f) => f.slotId === fp.slotId);
      if (trackIndex > 0) {
        entry.after = allFingerprints[trackIndex - 1].slotId;
      }
      return entry;
    });
  }

  writeFileSync(yamlPath, YAML.stringify(presetDefinition), "utf-8");

  return {
    success: true,
    presetName: input.presetName,
    fxChainFile: rfxContent ? rfxChainRelPath : undefined,
  };
}

// ─── delete-preset ───────────────────────────────────────────────

export interface DeletePresetInput {
  presetName: string;
}

export interface DeletePresetOutput {
  success: boolean;
  deleted: boolean;
}

/**
 * Delete a preset by name. Removes the YAML file and associated rfxchain file.
 */
export function deletePreset(
  input: DeletePresetInput,
  reabasePath: string
): DeletePresetOutput {
  const presetsDirectory = join(reabasePath, "presets");

  // Find the preset YAML file by loading presets and matching by name
  const presets = loadPresets(presetsDirectory);
  const preset = presets.get(input.presetName);
  if (!preset) {
    return { success: false, deleted: false };
  }

  // Derive the YAML filename from the preset name slug
  const safeFilename = input.presetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);

  if (!existsSync(yamlPath)) {
    return { success: false, deleted: false };
  }

  // Delete the rfxchain file if it exists
  if (preset.fxChainFile) {
    const rfxPath = join(presetsDirectory, preset.fxChainFile);
    if (existsSync(rfxPath)) {
      unlinkSync(rfxPath);
    }
  }

  // Delete the YAML file
  unlinkSync(yamlPath);

  return { success: true, deleted: true };
}

// ─── update-presets ───────────────────────────────────────────────

export interface UpdatePresetsInput {
  trackChunk: string;
  /** For each preset name, the slotIds assigned to it */
  ownership: Record<string, string[]>;
  /** slotIds that are explicitly released (local-only) */
  released: string[];
}

export interface UpdatePresetsOutput {
  success: boolean;
  updatedPresets: string[];
  modifiedChunk: string;
}

/**
 * Update preset files based on the track's current state and ownership assignments.
 * Writes new state files, overrides, and rfxchains as needed.
 */
export function updatePresets(
  input: UpdatePresetsInput,
  reabasePath: string
): UpdatePresetsOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const snapshotsDirectory = join(reabasePath, "snapshots");
  const track = parseTrackChunk(input.trackChunk);
  let currentChain = captureFxChain(track);

  // Resolve slotIds from stored slot map
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap) {
      currentChain = resolveSlotIds(currentChain, slotMap);
    }
  }

  // Load and resolve preset
  const presetName = getExtState(track, "reabase_preset");
  if (!presetName) {
    throw new Error("Track has no preset assigned");
  }

  const presets = loadPresets(presetsDirectory);
  const resolvedPreset = resolvePreset(presetName, presets, presetsDirectory);
  const inheritanceChain = resolvedPreset.inheritanceChain;

  const updatedPresets: string[] = [];

  // Process each preset in the inheritance chain that has ownership entries
  for (let i = 0; i < inheritanceChain.length; i++) {
    const presetNameInChain = inheritanceChain[i];
    const ownedSlotIds = input.ownership[presetNameInChain];
    if (!ownedSlotIds || ownedSlotIds.length === 0) continue;

    const definition = presets.get(presetNameInChain);
    if (!definition) continue;

    // Collect current fingerprints for owned slotIds (preserve order from current chain)
    const ownedFingerprints = currentChain.filter((fx) =>
      ownedSlotIds.includes(fx.slotId)
    );

    const isRoot = i === 0;
    if (isRoot) {
      updateRootPreset(presetsDirectory, definition, ownedFingerprints);
    } else {
      // Build parent chain by resolving up to (but not including) this level
      const parentPresetName = inheritanceChain[i - 1];
      const parentResolved = resolvePreset(
        parentPresetName,
        presets,
        presetsDirectory
      );
      updateChildPreset(
        presetsDirectory,
        definition,
        parentResolved.fxChain,
        ownedFingerprints
      );
    }

    updatedPresets.push(presetNameInChain);
  }

  // Re-snapshot the track
  const trackName = getTrackName(track) ?? "unnamed";
  const trackGuid = getTrackGuid(track) ?? "unknown";

  // Reload presets after writing to get fresh version hash and filter snapshot
  const freshPresets = loadPresets(presetsDirectory);
  let presetVersion = "initial";
  let snapshotChain = currentChain;
  try {
    const freshResolved = resolvePreset(presetName, freshPresets, presetsDirectory);
    presetVersion = freshResolved.version;
    // Filter snapshot to only include plugins in the resolved chain.
    // Released plugins are excluded so they appear as local additions.
    const resolvedSlotIds = new Set(freshResolved.fxChain.map((fx) => fx.slotId));
    snapshotChain = currentChain.filter((fx) => resolvedSlotIds.has(fx.slotId));
  } catch {
    // If preset can't be resolved after update, use placeholder
  }

  const snapshotKey = trackName.toLowerCase();
  const snapshotPath = join(snapshotsDirectory, snapshotKey + ".json");

  writeSnapshot(snapshotPath, {
    version: 1,
    trackGuid,
    trackName,
    preset: presetName,
    presetVersion,
    capturedAt: new Date().toISOString(),
    fxChain: snapshotChain,
  });

  // Update slot map
  const slotMap = buildSlotMap(currentChain);
  setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));

  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);
  return { success: true, updatedPresets, modifiedChunk };
}

// ─── revert-plugin ────────────────────────────────────────────────

export interface RevertPluginInput {
  trackChunk: string;
  slotId: string;
}

export interface RevertPluginOutput {
  modifiedChunk: string;
}

/**
 * Revert a single plugin's state back to its preset-defined state.
 * Finds the plugin by slotId in the current chain, looks up the
 * preset's state for that slot, and surgically replaces the state blob.
 */
export function revertPlugin(
  input: RevertPluginInput,
  reabasePath: string
): RevertPluginOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const track = parseTrackChunk(input.trackChunk);
  let currentChain = captureFxChain(track);

  // Resolve slotIds from stored slot map
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap) {
      currentChain = resolveSlotIds(currentChain, slotMap);
    }
  }

  // Find the plugin's index in the current chain
  const pluginIndex = currentChain.findIndex(
    (fx) => fx.slotId === input.slotId
  );
  if (pluginIndex === -1) {
    throw new Error(`Plugin with slotId '${input.slotId}' not found in current chain`);
  }

  // Resolve the preset to get the target state
  const preset = getExtState(track, "reabase_preset");
  if (!preset) {
    throw new Error("Track has no preset assigned");
  }

  const presets = loadPresets(presetsDirectory);
  const resolvedPreset = resolvePreset(preset, presets, presetsDirectory);

  // Find the fingerprint for this slotId in the resolved chain
  const presetFingerprint = resolvedPreset.fxChain.find(
    (fx) => fx.slotId === input.slotId
  );
  if (!presetFingerprint) {
    throw new Error(
      `Plugin with slotId '${input.slotId}' not found in resolved preset '${preset}'`
    );
  }

  // Surgically replace the plugin's state
  replacePluginState(track, pluginIndex, presetFingerprint.stateBlob);

  // Update slot map
  const updatedChain = captureFxChain(track);
  const slotMap = buildSlotMap(
    resolveSlotIds(updatedChain, parseSlotMap(slotMapJson ?? "{}") ?? {})
  );
  setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));

  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);
  return { modifiedChunk };
}

// ─── helpers ─────────────────────────────────────────────────────

/**
 * Parse a track chunk. SWS returns the full `<TRACK {GUID}\n...\n>` text.
 * We wrap it in a synthetic REAPER_PROJECT to reuse our parser,
 * then extract the TRACK node.
 */
function parseTrackChunk(chunk: string): RppNode {
  const wrapped = `<REAPER_PROJECT\n${chunk}\n>`;
  const root = parseRpp(wrapped);
  const tracks = getTracks(root);
  if (tracks.length === 0) {
    throw new Error("Could not parse track chunk: no TRACK node found");
  }
  return tracks[0];
}

/**
 * Serialize a track node back to chunk text (matching original line endings).
 */
function serializeTrackChunk(track: RppNode, originalChunk: string): string {
  const lineEnding = detectLineEnding(originalChunk);
  const wrapper: RppNode = {
    kind: "node",
    token: "REAPER_PROJECT",
    params: [],
    children: [track],
  };
  const serialized = serializeRpp(wrapper, { lineEnding });

  // Extract the TRACK block from the wrapper.
  // The serialized output is `<REAPER_PROJECT\n  <TRACK ...>\n  ...\n  >\n>`
  // We need just the `<TRACK ...> ... >` portion, with indentation removed.
  const lines = serialized.split(lineEnding);

  // Find the TRACK block start and end
  const trackStart = lines.findIndex((l) => l.trimStart().startsWith("<TRACK"));
  const trackEnd = lines.length - 3; // TRACK's closing > is before the REAPER_PROJECT closing > and trailing empty line

  if (trackStart === -1) {
    throw new Error("Failed to extract TRACK from serialized output");
  }

  // Remove one level of indentation (2 spaces from the REAPER_PROJECT wrapper)
  const trackLines = lines.slice(trackStart, trackEnd + 1).map((line) => {
    if (line.startsWith("  ")) return line.slice(2);
    return line;
  });

  return trackLines.join(lineEnding);
}
