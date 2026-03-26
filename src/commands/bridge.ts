import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { parseRpp } from "../parser/parse.js";
import { serializeRpp, detectLineEnding } from "../parser/serialize.js";
import {
  getTracks,
  getTrackName,
  getTrackGuid,
  getExtState,
  setExtState,
} from "../parser/helpers.js";
import { captureFxChain, enrichWithParameters, hashParameters } from "../snapshot/capture.js";
import { normalizeBlobForComparison } from "../snapshot/normalize.js";
import { parsePresetFxChain, serializePresetFxChain } from "../preset/rfxchain.js";
import { readSnapshot, writeSnapshot } from "../snapshot/store.js";
import { loadPresets } from "../preset/loader.js";
import { resolvePreset } from "../preset/resolver.js";
import { threeWayMerge } from "../merge/three-way.js";
import { updateRootPreset, updateChildPreset } from "../preset/writer.js";
import { applyResolvedChainToTrack } from "./apply.js";
import { buildSlotMap, serializeSlotMap, parseSlotMap, resolveSlotIds } from "../slot/map.js";
import { generateSlotId } from "../slot/identity.js";
import YAML from "yaml";
import type { RppNode } from "../parser/types.js";
import type { FxFingerprint, ParameterValue } from "../snapshot/types.js";
import type { PresetDefinition } from "../preset/types.js";
import type { MergeResult } from "../merge/types.js";

// ─── inspect ─────────────────────────────────────────────────────

export interface InspectInput {
  trackChunk: string;
  /** Parameter maps from Lua's TrackFX_GetParam, one per FX */
  fxParameters?: Record<string, ParameterValue>[];
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
  reabasePath: string,
  fxParameters?: Record<string, ParameterValue>[]
): InspectOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const snapshotsDirectory = join(reabasePath, "snapshots");

  const presets = loadPresets(presetsDirectory);
  const presetList = [...presets.values()].map((p) => ({
    name: p.name,
    description: p.description,
    extends: p.extends,
  }));

  // Parse the track chunk. SWS returns the full <TRACK ...> block.
  const track = parseTrackChunk(trackChunk);
  const trackName = getTrackName(track);
  const trackGuid = getTrackGuid(track);
  const preset = getExtState(track, "reabase_preset");
  let currentChain = captureFxChain(track);

  // Enrich with parameters from Lua (for state hashing)
  if (fxParameters) {
    currentChain = enrichWithParameters(currentChain, fxParameters);
  }

  // Resolve slotIds from stored slot map (if available)
  const slotMapJson = getExtState(track, "reabase_slot_map");
  let slotMapResolved = false;
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap) {
      currentChain = resolveSlotIds(currentChain, slotMap);
      slotMapResolved = true;
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

  // Resolve unmatched plugins against the preset's chain.
  // When there's no slot map, this matches all plugins.
  // When there IS a slot map, this catches newly added plugins not in the map.
  if (!slotMapResolved) {
    const presetSlotMap = buildSlotMap(resolvedPreset.fxChain);
    currentChain = resolveSlotIds(currentChain, presetSlotMap);
  } else {
    // Hybrid: plugins already in slot map keep their IDs.
    // Unmatched plugins fall through to preset identity matching.
    const existingSlotMap = parseSlotMap(slotMapJson!);
    const matchedSlotIds = existingSlotMap ? new Set(Object.keys(existingSlotMap)) : new Set<string>();
    const unmatchedIndices: number[] = [];
    for (let i = 0; i < currentChain.length; i++) {
      if (!matchedSlotIds.has(currentChain[i].slotId)) {
        unmatchedIndices.push(i);
      }
    }
    if (unmatchedIndices.length > 0) {
      const usedSlotIds = new Set(currentChain.map((fx) => fx.slotId));
      const presetSlotMap = buildSlotMap(resolvedPreset.fxChain);
      const availablePresetMap: typeof presetSlotMap = {};
      for (const [slotId, entry] of Object.entries(presetSlotMap)) {
        if (!usedSlotIds.has(slotId)) {
          availablePresetMap[slotId] = entry;
        }
      }
      const unmatchedChain = unmatchedIndices.map((i) => currentChain[i]);
      const resolved2 = resolveSlotIds(unmatchedChain, availablePresetMap);
      for (let j = 0; j < unmatchedIndices.length; j++) {
        currentChain[unmatchedIndices[j]] = resolved2[j];
      }
    }
  }

  // Load snapshot
  const snapshotKey = snapshotKeyFor(trackGuid);
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

  // Determine status from merge actions.
  // Only count keep_local (preset-managed plugin modified locally) as a local change.
  // add_local (unmanaged plugins on the track) is expected and doesn't affect status.
  let localChanged = merge.actions.some(
    (a) => a.type === "keep_local" || a.type === "remove_local"
  );
  let upstreamChanged = merge.actions.some(
    (a) => a.type === "use_new_base" || a.type === "add_base" || a.type === "remove"
  );

  // Detect hidden state changes: for plugins where params match (keep_base),
  // compare normalized blobs to catch internal state changes not exposed via
  // TrackFX_GetParam (e.g., Snap Heap module configurations, multiband routing).
  // Blobs are normalized per plugin type to strip non-deterministic host metadata.
  if (!localChanged) {
    const snapshotBySlot = new Map(snapshot.fxChain.map((fx) => [fx.slotId, fx]));
    const currentBySlot = new Map(currentChain.map((fx) => [fx.slotId, fx]));
    for (const action of merge.actions) {
      if (action.type === "keep_base") {
        const snapshotFx = snapshotBySlot.get(action.fx.slotId);
        const currentFx = currentBySlot.get(action.fx.slotId);
        if (snapshotFx?.stateBlob && currentFx?.stateBlob) {
          const normalizedSnapshot = normalizeBlobForComparison(snapshotFx.stateBlob, snapshotFx.pluginType);
          const normalizedCurrent = normalizeBlobForComparison(currentFx.stateBlob, currentFx.pluginType);
          if (normalizedSnapshot !== normalizedCurrent) {
            localChanged = true;
            break;
          }
        }
      }
    }
  }

  // Detect order changes: compare slotId ordering of managed plugins.
  const resolvedSlotIds = new Set(resolvedPreset.fxChain.map((fx) => fx.slotId));
  const snapshotOrder = snapshot.fxChain.map((fx) => fx.slotId);
  const currentOrder = currentChain
    .filter((fx) => resolvedSlotIds.has(fx.slotId))
    .map((fx) => fx.slotId);
  const presetOrder = resolvedPreset.fxChain.map((fx) => fx.slotId);

  // Local reorder: user dragged plugins to a different order (always detect)
  const localReordered = snapshotOrder.join(",") !== currentOrder.join(",")
    && snapshotOrder.length === currentOrder.length;
  if (localReordered) localChanged = true;

  // Upstream reorder: preset defines a different order than the snapshot.
  // Only flag when there are actual state changes too — otherwise the order
  // difference is just the preset resolver outputting in parent-first order
  // which naturally differs from track order for child presets.
  const hasStateChanges = merge.actions.some(
    (a) => a.type !== "keep_base" && a.type !== "add_local"
  );
  if (hasStateChanges) {
    const upstreamReordered = snapshotOrder.join(",") !== presetOrder.join(",")
      && snapshotOrder.length === presetOrder.length;
    if (upstreamReordered) upstreamChanged = true;
  }
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
  /** Parameter maps for each FX — Lua applies these via TrackFX_SetParam */
  parameterMaps: Record<string, ParameterValue>[];
}

/**
 * Apply a resolved FX chain to a track chunk and return the modified chunk.
 * Also returns parameter maps for Lua to apply via TrackFX_SetParam.
 */
export function applyChunk(input: ApplyChunkInput): ApplyChunkOutput {
  const track = parseTrackChunk(input.trackChunk);
  applyResolvedChainToTrack(track, input.resolvedChain);

  // Write slot map to P_EXT
  const slotMap = buildSlotMap(input.resolvedChain);
  setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));

  // Extract parameter maps from resolved chain for Lua to apply
  const parameterMaps = input.resolvedChain.map((fx) => fx.parameters);

  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);
  return { modifiedChunk, parameterMaps };
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
  /** Parameter maps from Lua's TrackFX_GetParam, one per FX */
  fxParameters?: Record<string, ParameterValue>[];
  /** When true, keep auto-generated unique slotIds instead of resolving against
   *  the preset chain. Used by "Keep both" mode so existing plugins stay separate
   *  from preset-managed plugins (treated as local additions). */
  preserveLocalSlotIds?: boolean;
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
  const rawTrackGuid = getTrackGuid(track);
  const trackGuid = rawTrackGuid ?? "unknown";
  let currentChain = captureFxChain(track);

  // Enrich with parameters from Lua (for state hashing)
  if (input.fxParameters) {
    currentChain = enrichWithParameters(currentChain, input.fxParameters);
  }

  // Load preset info (needed for slot resolution and snapshot filtering)
  const presets = loadPresets(presetsDirectory);
  let presetVersion = "initial";
  let resolved: ReturnType<typeof resolvePreset> | null = null;
  try {
    resolved = resolvePreset(input.preset, presets, presetsDirectory);
    presetVersion = resolved.version;
  } catch {
    // If preset can't be resolved, continue with placeholder version
  }

  // Resolve slotIds in two stages:
  // 1. Match against stored slot map (for plugins already known)
  // 2. For remaining unmatched plugins, fall back to preset identity matching
  //    (catches newly added plugins that aren't in the slot map yet)
  // Exception: preserveLocalSlotIds skips ALL resolution so existing plugins
  // keep their unique auto-generated slotIds (used by initial "Keep both" snapshot).
  // This must also ignore stale slot maps from previous assignments.
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (!input.preserveLocalSlotIds && slotMapJson) {
    const existingSlotMap = parseSlotMap(slotMapJson);
    if (existingSlotMap) {
      currentChain = resolveSlotIds(currentChain, existingSlotMap);

      // Stage 2: for plugins that weren't matched by the slot map (still have
      // auto-generated unique slotIds), try to match against the preset chain.
      // This handles plugins added via TrackFX_AddByName in "Keep both" mode.
      if (resolved) {
        const matchedSlotIds = new Set(Object.keys(existingSlotMap));
        const unmatchedIndices: number[] = [];
        for (let i = 0; i < currentChain.length; i++) {
          if (!matchedSlotIds.has(currentChain[i].slotId)) {
            unmatchedIndices.push(i);
          }
        }
        if (unmatchedIndices.length > 0) {
          const usedSlotIds = new Set(currentChain.map((fx) => fx.slotId));
          const presetSlotMap = buildSlotMap(resolved.fxChain);
          const availablePresetMap: typeof presetSlotMap = {};
          for (const [slotId, entry] of Object.entries(presetSlotMap)) {
            if (!usedSlotIds.has(slotId)) {
              availablePresetMap[slotId] = entry;
            }
          }
          const unmatchedChain = unmatchedIndices.map((i) => currentChain[i]);
          const resolved2 = resolveSlotIds(unmatchedChain, availablePresetMap);
          for (let j = 0; j < unmatchedIndices.length; j++) {
            currentChain[unmatchedIndices[j]] = resolved2[j];
          }
        }
      }
    }
  } else if (resolved && !input.preserveLocalSlotIds) {
    const presetSlotMap = buildSlotMap(resolved.fxChain);
    currentChain = resolveSlotIds(currentChain, presetSlotMap);
  }

  // Filter snapshot to only include plugins in the resolved chain.
  // Plugins not in the preset appear as local additions ("add_local")
  // rather than being baked into the baseline.
  let snapshotChain = currentChain;
  if (resolved) {
    const resolvedSlotIds = new Set(resolved.fxChain.map((fx) => fx.slotId));
    snapshotChain = currentChain.filter((fx) => resolvedSlotIds.has(fx.slotId));
  }

  // Use raw GUID (not fallback) for snapshot key — must match inspectTrack's lookup
  const snapshotKey = snapshotKeyFor(rawTrackGuid);
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
  /** Maps 0-based plugin index to the slotId it should be inserted after.
   *  Used by drag-and-drop on the Extend tab to control child plugin positioning. */
  addAfter?: Record<string, string>;
  /** Parameter maps from Lua's TrackFX_GetParam, one per FX */
  fxParameters?: Record<string, ParameterValue>[];
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

  const presetRelPath = `fx/${safeFilename}.json`;
  const presetAbsPath = join(presetsDirectory, presetRelPath);
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
  if (input.fxParameters) {
    allFingerprints = enrichWithParameters(allFingerprints, input.fxParameters);
  }
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap) {
      allFingerprints = resolveSlotIds(allFingerprints, slotMap);
    }
  }

  // Determine selected fingerprints
  let presetContent: string | null;
  let selectedFingerprints: FxFingerprint[];

  if (input.selectedPlugins) {
    selectedFingerprints = input.selectedPlugins
      .filter((i) => i >= 0 && i < allFingerprints.length)
      .map((i) => allFingerprints[i]);

    presetContent = selectedFingerprints.length > 0
      ? serializePresetFxChain(selectedFingerprints)
      : null;
  } else {
    selectedFingerprints = allFingerprints;
    presetContent = selectedFingerprints.length > 0
      ? serializePresetFxChain(selectedFingerprints)
      : null;
  }

  // When extending with no additions, we don't need a preset file
  if (!presetContent && !input.extendsPreset) {
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

  if (presetContent) {
    presetDefinition.fxChainFile = presetRelPath;
    writeFileSync(presetAbsPath, presetContent, "utf-8");
  }

  // Write plugins list with slot IDs (root presets only)
  if (!input.extendsPreset && selectedFingerprints.length > 0) {
    presetDefinition.plugins = selectedFingerprints.map((fp) => ({ id: fp.slotId }));
  }

  // Write add entries for child presets (proper slotIds, positioning, and origin)
  if (input.extendsPreset && selectedFingerprints.length > 0) {
    presetDefinition.add = selectedFingerprints.map((fp) => {
      const entry: { id: string; after?: string } = { id: fp.slotId };
      const trackIndex = allFingerprints.findIndex((f) => f.slotId === fp.slotId);

      if (input.addAfter && String(trackIndex) in input.addAfter) {
        // Use drag-and-drop positioning from the UI
        entry.after = input.addAfter[String(trackIndex)];
      } else if (trackIndex > 0) {
        // Default: position relative to the previous plugin in the track chain
        entry.after = allFingerprints[trackIndex - 1].slotId;
      }
      return entry;
    });
  }

  writeFileSync(yamlPath, YAML.stringify(presetDefinition), "utf-8");

  return {
    success: true,
    presetName: input.presetName,
    fxChainFile: presetContent ? presetRelPath : undefined,
  };
}

// ─── delete-preset ───────────────────────────────────────────────

export interface DeletePresetInput {
  presetName: string;
}

export interface DeletePresetOutput {
  success: boolean;
  deleted: boolean;
  /** Names of all presets deleted (includes cascaded children) */
  deletedPresets?: string[];
}

/**
 * Delete a preset by name. Cascades to all child presets that extend it
 * (directly or transitively). Removes YAML files and associated data files.
 */
export function deletePreset(
  input: DeletePresetInput,
  reabasePath: string
): DeletePresetOutput {
  const presetsDirectory = join(reabasePath, "presets");

  const presets = loadPresets(presetsDirectory);
  const preset = presets.get(input.presetName);
  if (!preset) {
    return { success: false, deleted: false };
  }

  // Collect all presets to delete: the target + all descendants
  const toDelete = collectDescendants(input.presetName, presets);
  const deletedPresets: string[] = [];

  for (const name of toDelete) {
    const def = presets.get(name);
    if (!def) continue;

    const safeFilename = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);

    // Delete the preset data file if it exists
    if (def.fxChainFile) {
      const dataPath = join(presetsDirectory, def.fxChainFile);
      if (existsSync(dataPath)) {
        unlinkSync(dataPath);
      }
    }

    // Delete override state files
    if (def.override) {
      for (const entry of Object.values(def.override)) {
        const statePath = join(presetsDirectory, entry.stateFile);
        if (existsSync(statePath)) {
          unlinkSync(statePath);
        }
      }
    }

    // Delete the YAML file
    if (existsSync(yamlPath)) {
      unlinkSync(yamlPath);
      deletedPresets.push(name);
    }
  }

  return { success: true, deleted: true, deletedPresets };
}

/**
 * Collect a preset and all its descendants (children, grandchildren, etc.)
 * in dependency order (children before parents).
 */
function collectDescendants(
  name: string,
  presets: Map<string, PresetDefinition>
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();

  function visit(current: string): void {
    if (visited.has(current)) return;
    visited.add(current);

    // Find all direct children
    for (const [childName, childDef] of presets) {
      if (childDef.extends === current) {
        visit(childName);
      }
    }

    result.push(current);
  }

  visit(name);
  return result;
}

// ─── update-presets ───────────────────────────────────────────────

export interface UpdatePresetsInput {
  trackChunk: string;
  /** For each preset name, the slotIds assigned to it */
  ownership: Record<string, string[]>;
  /** slotIds that are explicitly released (local-only) */
  released: string[];
  /** Parameter maps from Lua's TrackFX_GetParam, one per FX */
  fxParameters?: Record<string, ParameterValue>[];
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
  if (input.fxParameters) {
    currentChain = enrichWithParameters(currentChain, input.fxParameters);
  }

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
  const rawTrackGuid = getTrackGuid(track);
  const trackGuid = rawTrackGuid ?? "unknown";

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

  const snapshotKey = snapshotKeyFor(rawTrackGuid);
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
  /** Parameter map for the reverted plugin — Lua applies via TrackFX_SetParam */
  parameterMap: Record<string, ParameterValue>;
  /** 0-based FX index of the plugin to revert */
  pluginIndex: number;
  /** State blob for full restoration via temp track + CopyToTrack */
  stateBlob?: string;
  /** Plugin type token needed for building temp chunk */
  pluginType?: string;
  /** Plugin opening-line params needed for building temp chunk */
  pluginParams?: (string | number)[];
  /** Plugin display name needed for building temp chunk */
  pluginName?: string;
}

/**
 * Revert a single plugin's state back to its preset-defined state.
 * Returns the preset's parameter map for Lua to apply via TrackFX_SetParam.
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

  return {
    parameterMap: presetFingerprint.parameters,
    pluginIndex,
    stateBlob: presetFingerprint.stateBlob,
    pluginType: presetFingerprint.pluginType,
    pluginParams: presetFingerprint.pluginParams,
    pluginName: presetFingerprint.pluginName,
  };
}

// ─── unlink-override ──────────────────────────────────────────────

export interface UnlinkOverrideInput {
  trackChunk: string;
  slotId: string;
  fxParameters?: Record<string, ParameterValue>[];
}

export interface UnlinkOverrideOutput {
  success: boolean;
  newSlotId: string;
  modifiedChunk: string;
}

/**
 * Convert a child preset's override into a separate addition ("unlink").
 * The parent's original plugin is restored at the original slotId,
 * and the child's version becomes a new addition with a unique slotId.
 */
export function unlinkOverride(
  input: UnlinkOverrideInput,
  reabasePath: string
): UnlinkOverrideOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const track = parseTrackChunk(input.trackChunk);

  const presetName = getExtState(track, "reabase_preset");
  if (!presetName) {
    throw new Error("Track has no preset assigned");
  }

  const presets = loadPresets(presetsDirectory);
  const resolvedPreset = resolvePreset(presetName, presets, presetsDirectory);

  // Find the plugin in the resolved chain for structural info
  const resolvedFx = resolvedPreset.fxChain.find((fx) => fx.slotId === input.slotId);
  if (!resolvedFx) {
    throw new Error(`Plugin with slotId '${input.slotId}' not found in resolved preset`);
  }

  // Find which child preset overrides this slotId
  const { definition: childDef, index: childIndex } = findChildPresetForSlot(
    input.slotId, resolvedPreset.inheritanceChain, presets, "override"
  );

  // Get the override's parameters (from the state file or current track)
  let overrideParams: Record<string, ParameterValue> = resolvedFx.parameters;
  if (childDef.override?.[input.slotId]?.stateFile) {
    const stateFilePath = resolve(presetsDirectory, childDef.override[input.slotId].stateFile);
    if (existsSync(stateFilePath)) {
      overrideParams = JSON.parse(readFileSync(stateFilePath, "utf-8"));
    }
  }

  // Generate a new unique slotId
  const existingIds = new Set(resolvedPreset.fxChain.map((fx) => fx.slotId));
  const newSlotId = generateSlotId(resolvedFx.pluginName, existingIds);

  // Determine insertion position (after the overridden slot)
  const resolvedIndex = resolvedPreset.fxChain.findIndex((fx) => fx.slotId === input.slotId);
  const afterSlotId = input.slotId; // Insert after the parent's slot

  // Rewrite the child preset YAML
  const safeFilename = childDef.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);

  // Remove the override entry
  const newOverride = { ...childDef.override };
  delete newOverride[input.slotId];

  // Build the new plugin entry for the additions file
  const newPlugin: FxFingerprint = {
    pluginName: resolvedFx.pluginName,
    pluginType: resolvedFx.pluginType,
    pluginParams: resolvedFx.pluginParams,
    slotId: newSlotId,
    parameters: overrideParams,
    stateHash: hashParameters(overrideParams),
  };

  // Read or create the child's fxChainFile
  const fxDirectory = join(presetsDirectory, "fx");
  mkdirSync(fxDirectory, { recursive: true });
  const presetRelPath = childDef.fxChainFile ?? `fx/${safeFilename}.json`;
  const presetAbsPath = resolve(presetsDirectory, presetRelPath);

  let existingPlugins: FxFingerprint[] = [];
  if (childDef.fxChainFile && existsSync(presetAbsPath)) {
    existingPlugins = parsePresetFxChain(readFileSync(presetAbsPath, "utf-8"));
  }
  existingPlugins.push(newPlugin);
  writeFileSync(presetAbsPath, serializePresetFxChain(existingPlugins), "utf-8");

  // Build new add entries
  const existingAdd = childDef.add ?? [];
  const newAdd = [...existingAdd, { id: newSlotId, after: afterSlotId }];

  // Write updated YAML
  const yamlDefinition: Record<string, unknown> = {
    name: childDef.name,
  };
  if (childDef.description) yamlDefinition.description = childDef.description;
  if (childDef.extends) yamlDefinition.extends = childDef.extends;
  if (Object.keys(newOverride).length > 0) yamlDefinition.override = newOverride;
  if (childDef.remove && childDef.remove.length > 0) yamlDefinition.remove = childDef.remove;
  yamlDefinition.fxChainFile = presetRelPath;
  yamlDefinition.add = newAdd;
  writeFileSync(yamlPath, YAML.stringify(yamlDefinition), "utf-8");

  // Clean up the old override state file
  if (childDef.override?.[input.slotId]?.stateFile) {
    const oldStatePath = resolve(presetsDirectory, childDef.override[input.slotId].stateFile);
    if (existsSync(oldStatePath)) {
      unlinkSync(oldStatePath);
    }
  }

  // Update the track's slot map: rename slotId -> newSlotId
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap && slotMap[input.slotId]) {
      slotMap[newSlotId] = { ...slotMap[input.slotId] };
      delete slotMap[input.slotId];
      setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));
    }
  }

  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);
  return { success: true, newSlotId, modifiedChunk };
}

// ─── link-as-override ────────────────────────────────────────────

export interface LinkAsOverrideInput {
  trackChunk: string;
  childSlotId: string;
  parentSlotId: string;
  fxParameters?: Record<string, ParameterValue>[];
}

export interface LinkAsOverrideOutput {
  success: boolean;
  modifiedChunk: string;
  parameterMaps: Record<string, ParameterValue>[];
}

/**
 * Convert a child preset's addition into an override of a parent slot ("link").
 * The child plugin stops being a separate instance and instead overrides
 * the parent's plugin at parentSlotId with the child's parameters.
 */
export function linkAsOverride(
  input: LinkAsOverrideInput,
  reabasePath: string
): LinkAsOverrideOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const track = parseTrackChunk(input.trackChunk);

  const presetName = getExtState(track, "reabase_preset");
  if (!presetName) {
    throw new Error("Track has no preset assigned");
  }

  const presets = loadPresets(presetsDirectory);
  const resolvedPreset = resolvePreset(presetName, presets, presetsDirectory);

  // Find both plugins in the resolved chain
  const childFx = resolvedPreset.fxChain.find((fx) => fx.slotId === input.childSlotId);
  const parentFx = resolvedPreset.fxChain.find((fx) => fx.slotId === input.parentSlotId);

  if (!childFx) {
    throw new Error(`Child plugin '${input.childSlotId}' not found in resolved preset`);
  }
  if (!parentFx) {
    throw new Error(`Parent plugin '${input.parentSlotId}' not found in resolved preset`);
  }

  // Verify same plugin type
  if (childFx.pluginType !== parentFx.pluginType || childFx.pluginName !== parentFx.pluginName) {
    throw new Error(
      `Cannot override: plugin types differ (${childFx.pluginName} vs ${parentFx.pluginName})`
    );
  }

  // Find which child preset owns the addition
  const { definition: childDef } = findChildPresetForSlot(
    input.childSlotId, resolvedPreset.inheritanceChain, presets, "add"
  );

  const safeFilename = childDef.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);
  const fxDirectory = join(presetsDirectory, "fx");
  mkdirSync(fxDirectory, { recursive: true });

  // Get the child plugin's parameters
  const childParams = childFx.parameters;

  // Write the override state file
  const stateFileName = `fx/${childDef.name}_${input.parentSlotId}.json`;
  const stateFilePath = resolve(presetsDirectory, stateFileName);
  writeFileSync(stateFilePath, JSON.stringify(childParams, null, 2), "utf-8");

  // Remove the child from the add list
  const newAdd = (childDef.add ?? []).filter((a) => a.id !== input.childSlotId);

  // Remove the child from the fxChainFile
  if (childDef.fxChainFile) {
    const presetAbsPath = resolve(presetsDirectory, childDef.fxChainFile);
    if (existsSync(presetAbsPath)) {
      const plugins = parsePresetFxChain(readFileSync(presetAbsPath, "utf-8"));
      const filtered = plugins.filter((p) => p.slotId !== input.childSlotId);
      if (filtered.length > 0) {
        writeFileSync(presetAbsPath, serializePresetFxChain(filtered), "utf-8");
      } else {
        unlinkSync(presetAbsPath);
      }
    }
  }

  // Build new override map
  const newOverride = { ...(childDef.override ?? {}) };
  newOverride[input.parentSlotId] = { stateFile: stateFileName };

  // Write updated YAML
  const yamlDefinition: Record<string, unknown> = {
    name: childDef.name,
  };
  if (childDef.description) yamlDefinition.description = childDef.description;
  if (childDef.extends) yamlDefinition.extends = childDef.extends;
  yamlDefinition.override = newOverride;
  if (childDef.remove && childDef.remove.length > 0) yamlDefinition.remove = childDef.remove;
  if (newAdd.length > 0) {
    yamlDefinition.fxChainFile = childDef.fxChainFile;
    yamlDefinition.add = newAdd;
  }
  // If no more additions, don't include fxChainFile/add
  writeFileSync(yamlPath, YAML.stringify(yamlDefinition), "utf-8");

  // Re-resolve the preset to get the new chain (with override applied)
  const freshPresets = loadPresets(presetsDirectory);
  const freshResolved = resolvePreset(presetName, freshPresets, presetsDirectory);

  // Rebuild the track's FXCHAIN with the new resolved chain
  applyResolvedChainToTrack(track, freshResolved.fxChain);

  // Update slot map
  const slotMap = buildSlotMap(freshResolved.fxChain);
  setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));

  const parameterMaps = freshResolved.fxChain.map((fx) => fx.parameters);
  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);

  return { success: true, modifiedChunk, parameterMaps };
}

// ─── helpers: find child preset for slot ─────────────────────────

/**
 * Find which child preset in the inheritance chain owns a slot
 * via either an `override` or `add` entry.
 */
function findChildPresetForSlot(
  slotId: string,
  inheritanceChain: string[],
  presets: Map<string, PresetDefinition>,
  mode: "override" | "add"
): { definition: PresetDefinition; index: number } {
  // Walk from leaf to root (children override parents)
  for (let i = inheritanceChain.length - 1; i >= 1; i--) {
    const def = presets.get(inheritanceChain[i]);
    if (!def) continue;

    if (mode === "override" && def.override?.[slotId]) {
      return { definition: def, index: i };
    }
    if (mode === "add" && def.add?.some((a) => a.id === slotId)) {
      return { definition: def, index: i };
    }
  }

  throw new Error(
    `No child preset found with ${mode} for slotId '${slotId}' in inheritance chain [${inheritanceChain.join(", ")}]`
  );
}

// ─── snapshot key ────────────────────────────────────────────────

/**
 * Compute a stable, unique snapshot filename key for a track.
 * Uses GUID (the only truly unique track identifier in REAPER) as the key,
 * with braces stripped for filesystem compatibility.
 */
function snapshotKeyFor(trackGuid: string | undefined): string {
  if (trackGuid) return trackGuid.replace(/[{}]/g, "").toLowerCase();
  return "unnamed";
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
  // We need just the `<TRACK ...> ... >` portion.
  //
  // IMPORTANT: GetTrackStateChunk returns chunks with ZERO indentation (flat format).
  // SetTrackStateChunk expects the same flat format. Our serializer adds 2-space-per-level
  // indentation, so we must strip ALL leading whitespace to match REAPER's expected format.
  const lines = serialized.split(lineEnding);

  // Find the TRACK block start and end
  const trackStart = lines.findIndex((l) => l.trimStart().startsWith("<TRACK"));
  const trackEnd = lines.length - 3; // TRACK's closing > is before the REAPER_PROJECT closing > and trailing empty line

  if (trackStart === -1) {
    throw new Error("Failed to extract TRACK from serialized output");
  }

  // Strip all leading whitespace — REAPER track chunks use flat format (no indentation)
  const trackLines = lines.slice(trackStart, trackEnd + 1).map((line) =>
    line.trimStart()
  );

  return trackLines.join(lineEnding);
}
