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
import { captureFxChain, enrichWithParameters } from "../snapshot/capture.js";
import { chainsReordered } from "../snapshot/diff.js";
import { normalizeBlobForComparison } from "../snapshot/normalize.js";
import { adoptSlotMapAsBaselineIfIntact } from "../snapshot/adopt.js";
import { serializePresetFxChain } from "../preset/rfxchain.js";
import { readSnapshot, writeSnapshot } from "../snapshot/store.js";
import { loadPresets } from "../preset/loader.js";
import { resolvePreset } from "../preset/resolver.js";
import { buildSlotSourceMap } from "../preset/membership.js";
import { threeWayMerge } from "../merge/three-way.js";
import { updatePresetOwnPlugins, updateComposition, deletePresetOwnPlugin } from "../preset/writer.js";
import { applyResolvedChainToTrack } from "./apply.js";
import { buildSlotMap, serializeSlotMap, parseSlotMap, resolveSlotIds } from "../slot/map.js";
import YAML from "yaml";
import type { RppNode } from "../parser/types.js";
import type { FxFingerprint, ParameterValue } from "../snapshot/types.js";
import type { ExcludedSlot, ResolvedPreset, SourceComposition } from "../preset/types.js";
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
  presets: {
    name: string;
    description?: string;
    imports?: string[];
    /** Folder slug (relative path from presets/) and its display label.
     *  The label falls back to the folder name when no `_category.yaml`
     *  is present in that folder. Empty slug = preset directly under
     *  presets/. */
    category: { slug: string; label: string };
  }[];
  /** Every category the loader saw, keyed by slug. The UI uses this to
   *  build hierarchy beyond what's reachable from the per-preset entries
   *  above (e.g. an empty parent folder with children). */
  categories: { slug: string; label: string }[];
  /** Sources contributing to the resolved preset, in resolution order:
   *  the container's own name (when it has its own plugins) followed by each
   *  imported preset. Each entry carries that source's OWN composition fields
   *  (`deactivated`/`excluded`/`order`) verbatim, so a source tab can render
   *  and edit its standalone state independently of the composed resolution. */
  sources: SourceComposition[];
  /** Preset's ideal resolved state (with origin set), null if no preset */
  resolvedChain: FxFingerprint[] | null;
  /** "<sourceName>/<slotId>" entries the preset has excluded from the
   *  resolved chain. Empty array when nothing is excluded; mirrored from
   *  the resolved preset so the UI can render excluded slots without
   *  re-loading YAML. */
  excluded: string[];
  /** The excluded slots with their fingerprint (origin set) and insert-index
   *  position in `resolvedChain`. Lets the UI render excluded slots
   *  grayed-in-place and offer un-exclude — `excluded` alone has only the
   *  refs. Empty array when nothing is excluded or no preset is resolved. */
  excludedChain: ExcludedSlot[];
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

  const { presets, categories } = loadPresets(presetsDirectory);
  const presetList = [...presets.values()].map((p) => ({
    name: p.name,
    description: p.description,
    imports: p.imports,
    category: {
      slug: p._categorySlug,
      label: categories.get(p._categorySlug)?.label ?? p._categorySlug,
    },
  }));
  const categoryList = [...categories.values()];

  // Parse the track chunk. SWS returns the full <TRACK ...> block.
  const track = parseTrackChunk(trackChunk);
  const trackName = getTrackName(track);
  const trackGuid = getTrackGuid(track);
  const preset = getExtState(track, "reabase_preset");
  const slotMapJson = getExtState(track, "reabase_slot_map");

  if (!preset) {
    return {
      trackName,
      trackGuid,
      preset: undefined,
      currentChain: resolveCurrentChainSlotIds(track, fxParameters, null, slotMapJson),
      presets: presetList,
      categories: categoryList,
      sources: [],
      resolvedChain: null,
      excluded: [],
      excludedChain: [],
      status: "no-preset",
      merge: null,
    };
  }

  // Try to resolve the preset
  let resolvedPreset;
  try {
    resolvedPreset = resolvePreset(preset, presets);
  } catch {
    return {
      trackName,
      trackGuid,
      preset,
      currentChain: resolveCurrentChainSlotIds(track, fxParameters, null, slotMapJson),
      presets: presetList,
      categories: categoryList,
      sources: [],
      resolvedChain: null,
      excluded: [],
      excludedChain: [],
      status: "unresolvable-preset",
      merge: null,
    };
  }

  // Capture the chain and resolve slotIds (slot map, then preset-identity
  // fallback for newly added plugins).
  const currentChain = resolveCurrentChainSlotIds(
    track,
    fxParameters,
    resolvedPreset,
    slotMapJson
  );

  // Load snapshot
  const snapshotKey = snapshotKeyFor(trackGuid);
  const snapshotPath = join(snapshotsDirectory, snapshotKey + ".json");
  let snapshot = readSnapshot(snapshotPath);

  if (!snapshot) {
    // Bug 1: a duplicated preset-bound track inherits reabase_slot_map and
    // its full FX chain via REAPER's track-copy behavior, but reabase has
    // no snapshot at the new GUID. If the slot map's stateHashes still
    // match the current chain, the track is intact relative to its last
    // baseline — adopt it as the snapshot at the new GUID instead of
    // falsely reporting "Not yet synced" (which exposes a destructive
    // "Apply preset changes" button).
    snapshot = adoptSlotMapAsBaselineIfIntact({
      trackName: trackName ?? "unnamed",
      trackGuid: trackGuid ?? "unknown",
      preset,
      presetVersion: resolvedPreset.version,
      slotMapJson,
      currentChain,
      resolvedPresetSlotIds: new Set(resolvedPreset.fxChain.map((fx) => fx.slotId)),
      snapshotPath,
    });
  }

  if (!snapshot) {
    // First sync — merge from empty base
    const merge = threeWayMerge([], resolvedPreset.fxChain, currentChain);
    return {
      trackName,
      trackGuid,
      preset,
      currentChain,
      presets: presetList,
      categories: categoryList,
      sources: resolvedPreset.sources,
      resolvedChain: resolvedPreset.fxChain,
      excluded: resolvedPreset.excluded,
      excludedChain: resolvedPreset.excludedChain,
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

  // Bug 4: surface blob-only changes at per-plugin granularity. The merge
  // hashes only the parameter map, so a plugin whose params match snapshot
  // but whose stateBlob differs (e.g., RS5K loading a different sample
  // file) lands as keep_base. Walk the keep_base actions, compare normalized
  // blobs, and promote to keep_local where they diverge so the UI row and
  // track status both reflect the local edit.
  promoteBlobOnlyChangesToKeepLocal(merge, snapshot.fxChain, currentChain);

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
  // Any local deviation from the preset counts as a local change: modified
  // plugins (keep_local), locally removed plugins (remove_local), and
  // plugins on the track that aren't in the preset (add_local).
  let localChanged = merge.actions.some(
    (a) => a.type === "keep_local" || a.type === "remove_local" || a.type === "add_local"
  );
  let upstreamChanged = merge.actions.some(
    (a) =>
      a.type === "use_new_base" ||
      a.type === "add_base" ||
      a.type === "remove" ||
      a.type === "merge_params"
  );

  // Detect order changes via the shared diff helper. `chainsReordered`
  // compares the relative ordering of slot IDs present in BOTH chains, so
  // local-only additions and locally-removed slots don't muddy the signal.
  if (chainsReordered(snapshot.fxChain, currentChain)) {
    localChanged = true;
  }

  // Upstream reorder: preset defines a different order than the snapshot.
  // Pure-reorder upstream changes must propagate through sync (Bug 3), so
  // we flag any preset reorder vs snapshot as upstream — even when there
  // are no per-plugin state changes alongside it.
  if (chainsReordered(snapshot.fxChain, resolvedPreset.fxChain)) {
    upstreamChanged = true;
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
    categories: categoryList,
    sources: resolvedPreset.sources,
    resolvedChain: resolvedPreset.fxChain,
    excluded: resolvedPreset.excluded,
    excludedChain: resolvedPreset.excludedChain,
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
  /** Scoped re-baseline (per-source pull). When set, only these slotIds are
   *  re-baselined from the current track state; every other slot keeps its
   *  entry from the *existing* snapshot verbatim, so the other sources' pending
   *  upstream/local status is preserved. Requires an existing snapshot; if none
   *  exists this falls back to a normal whole-track snapshot. The `pulledSlots`
   *  returned by `pullSource` feed directly into this. */
  rebaselineSlots?: string[];
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
  const { presets } = loadPresets(presetsDirectory);
  let presetVersion = "initial";
  let resolved: ReturnType<typeof resolvePreset> | null = null;
  try {
    resolved = resolvePreset(input.preset, presets);
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
  // rather than being baked into the baseline. Each kept slot is stamped
  // with its resolved `origin` so the baseline is source-aware (per-source
  // pull attributes upstream-removed slots from this record). `origin` is
  // inert to the three-way merge, so this is additive for whole-track flows.
  let snapshotChain = currentChain;
  if (resolved) {
    const originBySlot = new Map(resolved.fxChain.map((fx) => [fx.slotId, fx.origin]));
    snapshotChain = currentChain
      .filter((fx) => originBySlot.has(fx.slotId))
      .map((fx) => {
        const origin = originBySlot.get(fx.slotId);
        return origin ? { ...fx, origin } : fx;
      });
  }

  // Use raw GUID (not fallback) for snapshot key — must match inspectTrack's lookup
  const snapshotKey = snapshotKeyFor(rawTrackGuid);
  const snapshotPath = join(snapshotsDirectory, snapshotKey + ".json");

  // Scoped re-baseline (per-source pull): re-baseline only `rebaselineSlots`
  // from the current chain, preserving every other slot's entry from the
  // existing snapshot so the un-pulled sources keep their pending status. The
  // new chain is built in current-track order, so reorder detection stays
  // accurate on the next inspect.
  const existingForScope = input.rebaselineSlots
    ? readSnapshot(snapshotPath)
    : null;
  if (input.rebaselineSlots && existingForScope) {
    const rebaseline = new Set(input.rebaselineSlots);
    const rebaselineBySlot = new Map(snapshotChain.map((fx) => [fx.slotId, fx]));
    const existingBySlot = new Map(
      existingForScope.fxChain.map((fx) => [fx.slotId, fx])
    );
    const scopedChain: FxFingerprint[] = [];
    for (const fx of currentChain) {
      if (rebaseline.has(fx.slotId)) {
        // Re-baseline this slot from the (origin-stamped) current state.
        scopedChain.push(rebaselineBySlot.get(fx.slotId) ?? fx);
      } else if (existingBySlot.has(fx.slotId)) {
        // Preserve the prior baseline for un-pulled slots.
        scopedChain.push(existingBySlot.get(fx.slotId)!);
      }
      // else: a loose local plugin (in no source) — never part of the snapshot.
    }
    snapshotChain = scopedChain;
  }

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
  /** 0-based FX indices to include. If omitted, saves entire chain. */
  selectedPlugins?: number[];
  /** If true, overwrite an existing preset with the same slug. Defaults to false. */
  overwrite?: boolean;
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
 * Create a new plain preset from a track's current FX chain. Composed
 * presets (those that import other presets, declare order/excluded/etc.)
 * are created and edited via `updateComposition`, not here.
 */
export function savePreset(
  input: SavePresetInput,
  reabasePath: string
): SavePresetOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const fxDirectory = join(presetsDirectory, "fx");
  const track = parseTrackChunk(input.trackChunk);

  const safeFilename = input.presetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  const presetRelPath = `fx/${safeFilename}.json`;
  const presetAbsPath = join(presetsDirectory, presetRelPath);
  const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);

  if (existsSync(yamlPath) && !input.overwrite) {
    return {
      success: false,
      presetName: input.presetName,
      exists: true,
    };
  }

  // Capture fingerprints and resolve slotIds from the stored slot map.
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

  const selectedFingerprints: FxFingerprint[] = input.selectedPlugins
    ? input.selectedPlugins
        .filter((i) => i >= 0 && i < allFingerprints.length)
        .map((i) => allFingerprints[i])
    : allFingerprints;

  if (selectedFingerprints.length === 0) {
    throw new Error("Track has no FX chain to save as a preset");
  }

  mkdirSync(fxDirectory, { recursive: true });

  const presetDefinition: Record<string, unknown> = {
    name: input.presetName,
    fxChainFile: presetRelPath,
    plugins: selectedFingerprints.map((fp) => {
      const entry: { id: string; label?: string } = { id: fp.slotId };
      if (fp.displayName && fp.displayName.length > 0) {
        entry.label = fp.displayName;
      }
      return entry;
    }),
  };

  writeFileSync(presetAbsPath, serializePresetFxChain(selectedFingerprints), "utf-8");
  writeFileSync(yamlPath, YAML.stringify(presetDefinition), "utf-8");

  return {
    success: true,
    presetName: input.presetName,
    fxChainFile: presetRelPath,
  };
}

// ─── delete-preset ───────────────────────────────────────────────

export interface DeletePresetInput {
  presetName: string;
}

export interface DeletePresetOutput {
  success: boolean;
  deleted: boolean;
  /** When refusal is due to importers, this lists their preset names so the
   *  UI can show a clear error. Only set when success === false. */
  importedBy?: string[];
}

/**
 * Delete a preset by name. Refuses if any other preset imports it — the
 * caller (UI or CLI) must remove or update those importers first. This is
 * intentionally non-cascading: composition's import edges are user
 * decisions, not parent/child relationships, and silent cascade would be
 * surprising.
 */
export function deletePreset(
  input: DeletePresetInput,
  reabasePath: string
): DeletePresetOutput {
  const presetsDirectory = join(reabasePath, "presets");

  const { presets } = loadPresets(presetsDirectory);
  const preset = presets.get(input.presetName);
  if (!preset) {
    return { success: false, deleted: false };
  }

  const importers: string[] = [];
  for (const [otherName, otherDef] of presets) {
    if (otherName === input.presetName) continue;
    if (otherDef.imports?.includes(input.presetName)) {
      importers.push(otherName);
    }
  }
  if (importers.length > 0) {
    return { success: false, deleted: false, importedBy: importers };
  }

  const safeFilename = input.presetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const yamlPath = join(presetsDirectory, `${safeFilename}.yaml`);

  if (preset.fxChainFile) {
    const dataPath = join(presetsDirectory, preset.fxChainFile);
    if (existsSync(dataPath)) unlinkSync(dataPath);
  }

  if (existsSync(yamlPath)) unlinkSync(yamlPath);

  return { success: true, deleted: true };
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
 * Push the track's current plugin state back into the preset files. For
 * each entry in `ownership`, the named source preset's own plugins
 * (`plugins` + `fxChainFile`) are rewritten from the matching slotIds on
 * the track. Composition fields (imports, order, deactivated, excluded)
 * are preserved verbatim — those are managed via `updateComposition`.
 *
 * Each source — whether the composed container or any of its imports —
 * is just a plain preset on disk, so they're handled identically here.
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

  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap) {
      currentChain = resolveSlotIds(currentChain, slotMap);
    }
  }

  const presetName = getExtState(track, "reabase_preset");
  if (!presetName) {
    throw new Error("Track has no preset assigned");
  }

  const { presets } = loadPresets(presetsDirectory);
  const resolvedPreset = resolvePreset(presetName, presets);

  const updatedPresets: string[] = [];

  for (const source of resolvedPreset.sources) {
    const sourceName = source.name;
    const ownedSlotIds = input.ownership[sourceName];
    if (!ownedSlotIds || ownedSlotIds.length === 0) continue;

    const definition = presets.get(sourceName);
    if (!definition) continue;

    const ownedFingerprints = currentChain.filter((fx) =>
      ownedSlotIds.includes(fx.slotId)
    );
    updatePresetOwnPlugins(definition, ownedFingerprints);
    updatedPresets.push(sourceName);
  }

  // Re-snapshot the track
  const trackName = getTrackName(track) ?? "unnamed";
  const rawTrackGuid = getTrackGuid(track);
  const trackGuid = rawTrackGuid ?? "unknown";

  // Reload presets after writing to get fresh version hash and filter snapshot
  const { presets: freshPresets } = loadPresets(presetsDirectory);
  let presetVersion = "initial";
  let snapshotChain = currentChain;
  try {
    const freshResolved = resolvePreset(presetName, freshPresets);
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

  const { presets } = loadPresets(presetsDirectory);
  const resolvedPreset = resolvePreset(preset, presets);

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

// ─── pull-source ─────────────────────────────────────────────────

export interface PullSourceInput {
  trackChunk: string;
  /** The source to pull — the container preset's own name or an imported
   *  preset name. Must be one of the resolved preset's `sources`. */
  source: string;
  /** Parameter maps from Lua's TrackFX_GetParam, one per FX */
  fxParameters?: Record<string, ParameterValue>[];
}

export interface PullSourceOutput {
  modifiedChunk: string;
  /** Parameter maps for each FX in the new chain — Lua applies these via
   *  TrackFX_SetParam (mirrors apply-chunk). */
  parameterMaps: Record<string, ParameterValue>[];
  /** Source slots that were reconciled to their merged/upstream state. These
   *  feed `snapshot`'s `rebaselineSlots` so the scoped re-baseline marks just
   *  this source up-to-date. Excludes conflicts (left local) and
   *  upstream-removed slots (dropped). */
  pulledSlots: string[];
  /** Source slots left at their local state because pulling would clobber a
   *  conflicting local edit. The UI surfaces these; they are NOT re-baselined,
   *  so the conflict persists until resolved. */
  conflicts: string[];
}

/**
 * Pull upstream changes for a single source of a composed preset onto the
 * track, independently of the other sources.
 *
 * Only the named source's slots are touched: each is reconciled to the
 * three-way merge result (param merges, upstream updates, upstream adds);
 * upstream-removed slots are dropped; conflicting slots are left at their
 * local state and surfaced. Every other slot — other sources and loose local
 * plugins — is written back from the current track state verbatim, so their
 * pending upstream changes and local edits are untouched.
 *
 * The caller then re-snapshots scoped to `pulledSlots` (via `snapshot`'s
 * `rebaselineSlots`) so only this source reads up-to-date afterward.
 */
export function pullSource(
  input: PullSourceInput,
  reabasePath: string
): PullSourceOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const snapshotsDirectory = join(reabasePath, "snapshots");

  const track = parseTrackChunk(input.trackChunk);
  const trackGuid = getTrackGuid(track);
  const preset = getExtState(track, "reabase_preset");
  if (!preset) {
    throw new Error("Track has no preset assigned");
  }

  const { presets } = loadPresets(presetsDirectory);
  const resolvedPreset = resolvePreset(preset, presets);

  if (!resolvedPreset.sources.some((s) => s.name === input.source)) {
    throw new Error(
      `'${input.source}' is not a source of preset '${preset}'. ` +
        `Sources: [${resolvedPreset.sources.map((s) => s.name).join(", ")}].`
    );
  }

  const slotMapJson = getExtState(track, "reabase_slot_map");
  const currentChain = resolveCurrentChainSlotIds(
    track,
    input.fxParameters,
    resolvedPreset,
    slotMapJson
  );

  // Load the snapshot (old base). Per-source pull is a merge-aware op, so it
  // needs a baseline — without one there is nothing to reconcile against.
  const snapshotKey = snapshotKeyFor(trackGuid);
  const snapshotPath = join(snapshotsDirectory, snapshotKey + ".json");
  const snapshot = readSnapshot(snapshotPath);
  if (!snapshot) {
    throw new Error(
      "Track has no snapshot yet — assign or snapshot the preset before pulling a source"
    );
  }

  const merge = threeWayMerge(
    snapshot.fxChain,
    resolvedPreset.fxChain,
    currentChain
  );
  // Mirror inspect: surface blob-only edits as keep_local so a hidden local
  // edit on a source slot is treated as such (not silently overwritten).
  promoteBlobOnlyChangesToKeepLocal(merge, snapshot.fxChain, currentChain);

  const membership = buildSlotSourceMap(resolvedPreset.fxChain, snapshot.fxChain);
  const ownedBySource = (slotId: string): boolean =>
    membership.get(slotId) === input.source;

  // Index this source's merge actions.
  const resolvedBySlot = new Map(
    merge.resolvedChain.map((fx) => [fx.slotId, fx] as const)
  );
  const conflictSlots = new Set<string>();
  const removeSlots = new Set<string>();
  const addBaseForSource: FxFingerprint[] = [];
  for (const action of merge.actions) {
    if (action.type === "conflict") {
      if (ownedBySource(action.local.slotId)) conflictSlots.add(action.local.slotId);
    } else if (action.type === "remove") {
      if (action.slotId && ownedBySource(action.slotId)) removeSlots.add(action.slotId);
    } else if (action.type === "add_base") {
      if (ownedBySource(action.fx.slotId)) addBaseForSource.push(action.fx);
    }
  }

  // Build the new track chain. Walk the current chain (preserving its order);
  // for the pulled source swap in the merged state, drop removals, keep
  // conflicts local. Everything else is written back verbatim.
  const newChain: FxFingerprint[] = [];
  const pulledSlots: string[] = [];
  const conflicts: string[] = [];
  for (const fx of currentChain) {
    const slotId = fx.slotId;
    if (!ownedBySource(slotId)) {
      newChain.push(fx);
      continue;
    }
    if (removeSlots.has(slotId)) continue;
    if (conflictSlots.has(slotId)) {
      newChain.push(fx);
      conflicts.push(slotId);
      continue;
    }
    newChain.push(resolvedBySlot.get(slotId) ?? fx);
    pulledSlots.push(slotId);
  }

  // Inject this source's upstream-added slots at their resolved-order position.
  for (const addFx of addBaseForSource) {
    insertAnchoredBySlot(newChain, addFx, merge.resolvedChain);
    pulledSlots.push(addFx.slotId);
  }

  applyResolvedChainToTrack(track, newChain);
  const slotMap = buildSlotMap(newChain);
  setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));

  const parameterMaps = newChain.map((fx) => fx.parameters);
  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);

  return { modifiedChunk, parameterMaps, pulledSlots, conflicts };
}

/**
 * Insert `addFx` into `chain` at the position implied by `resolvedOrder`:
 * after the nearest preceding resolved-order slot already in the chain, else
 * before the nearest following one, else appended. Mirrors how the resolver
 * and three-way merge anchor injected slots to their neighbours.
 */
function insertAnchoredBySlot(
  chain: FxFingerprint[],
  addFx: FxFingerprint,
  resolvedOrder: FxFingerprint[]
): void {
  const order = resolvedOrder.map((fx) => fx.slotId);
  const idx = order.indexOf(addFx.slotId);
  const present = new Set(chain.map((fx) => fx.slotId));

  if (idx !== -1) {
    for (let j = idx - 1; j >= 0; j--) {
      if (present.has(order[j])) {
        const at = chain.findIndex((fx) => fx.slotId === order[j]);
        chain.splice(at + 1, 0, addFx);
        return;
      }
    }
    for (let j = idx + 1; j < order.length; j++) {
      if (present.has(order[j])) {
        const at = chain.findIndex((fx) => fx.slotId === order[j]);
        chain.splice(at, 0, addFx);
        return;
      }
    }
  }
  chain.push(addFx);
}

/**
 * Capture a track's FX chain and resolve stable slotIds onto it.
 *
 * Two-stage resolution: first match plugins against the stored slot map
 * (P_EXT), then — when a preset is known — fall back to preset-identity
 * matching for any plugins not yet in the map (newly added ones). Passing
 * `resolvedPreset = null` (no/unresolvable preset) does the slot-map stage
 * only. Shared by `inspectTrack` and `pullSource` so both see identical slot
 * identities.
 */
function resolveCurrentChainSlotIds(
  track: RppNode,
  fxParameters: Record<string, ParameterValue>[] | undefined,
  resolvedPreset: ResolvedPreset | null,
  slotMapJson: string | undefined
): FxFingerprint[] {
  let currentChain = captureFxChain(track);
  if (fxParameters) {
    currentChain = enrichWithParameters(currentChain, fxParameters);
  }

  let slotMapResolved = false;
  if (slotMapJson) {
    const slotMap = parseSlotMap(slotMapJson);
    if (slotMap) {
      currentChain = resolveSlotIds(currentChain, slotMap);
      slotMapResolved = true;
    }
  }

  if (!resolvedPreset) {
    // No preset to match unmatched plugins against — slot-map stage only.
    return currentChain;
  }

  if (!slotMapResolved) {
    const presetSlotMap = buildSlotMap(resolvedPreset.fxChain);
    currentChain = resolveSlotIds(currentChain, presetSlotMap);
  } else {
    const existingSlotMap = parseSlotMap(slotMapJson!);
    const matchedSlotIds = existingSlotMap
      ? new Set(Object.keys(existingSlotMap))
      : new Set<string>();
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

  return currentChain;
}

// ─── rename-slot ─────────────────────────────────────────────────

export interface RenameSlotInput {
  trackChunk: string;
  slotId: string;
  /** New label. Empty string clears the existing label. */
  label: string;
}

export interface RenameSlotOutput {
  success: boolean;
  modifiedChunk: string;
}

/**
 * Set or clear a slot's track-local label. The label round-trips through
 * the track's slot map (P_EXT `reabase_slot_map`) and surfaces as
 * `fp.displayName` on next capture.
 *
 * Track-local labels are independent of preset-provided labels — the UI
 * resolution order is: track-local label > preset label > pluginName.
 * Useful for labelling local additions that aren't part of any preset, or
 * giving the same plugin a track-specific name.
 */
export function renameSlot(input: RenameSlotInput): RenameSlotOutput {
  const track = parseTrackChunk(input.trackChunk);
  const slotMapJson = getExtState(track, "reabase_slot_map");
  if (!slotMapJson) {
    throw new Error(
      `Track has no slot map yet — apply or snapshot the preset first to establish slot identities`
    );
  }
  const slotMap = parseSlotMap(slotMapJson);
  if (!slotMap) {
    throw new Error(`Track's slot map is malformed; cannot rename slot`);
  }
  const entry = slotMap[input.slotId];
  if (!entry) {
    throw new Error(
      `Slot '${input.slotId}' not found in this track's slot map`
    );
  }

  if (input.label.length === 0) {
    delete entry.label;
  } else {
    entry.label = input.label;
  }
  slotMap[input.slotId] = entry;

  setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));
  const modifiedChunk = serializeTrackChunk(track, input.trackChunk);
  return { success: true, modifiedChunk };
}

// ─── update-composition ──────────────────────────────────────────

export interface UpdateCompositionInput {
  presetName: string;
  /** Pass to overwrite. Omit (`undefined`) to leave the field alone. Pass
   *  an empty array to clear it. */
  imports?: string[];
  order?: string[];
  deactivated?: string[];
  excluded?: string[];
}

export interface UpdateCompositionOutput {
  success: boolean;
  presetName: string;
}

/**
 * Edit a composed preset's composition fields in one shot. The Lua UI
 * typically sends the full new state of everything it manages after a
 * reorder / exclude-toggle / etc., so this is the single command that
 * covers all of: add/remove an import, reorder, set deactivated, set
 * excluded.
 */
export function updateCompositionBridge(
  input: UpdateCompositionInput,
  reabasePath: string
): UpdateCompositionOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const { presets } = loadPresets(presetsDirectory);
  const definition = presets.get(input.presetName);
  if (!definition) {
    throw new Error(`Preset '${input.presetName}' not found`);
  }
  updateComposition(definition, {
    imports: input.imports,
    order: input.order,
    deactivated: input.deactivated,
    excluded: input.excluded,
  });
  return { success: true, presetName: input.presetName };
}

// ─── delete-plugin ───────────────────────────────────────────────

export interface DeletePluginInput {
  /** The source (plain) preset to remove the plugin from. */
  presetName: string;
  /** The slotId of the plugin to remove — must be one of that preset's own
   *  plugins. */
  slotId: string;
}

export interface DeletePluginOutput {
  success: boolean;
}

/**
 * Fully remove a plugin from a source preset — the destructive counterpart
 * to `exclude`. Drops the slot from the preset's own `plugins` + `fxChainFile`
 * (via `deletePresetOwnPlugin`), then scrubs every now-dangling reference to
 * it from any preset's `order` / `deactivated` / `excluded`.
 *
 * The delete is global: the slot leaves the source's definition, so every
 * composed preset and downstream track that drew on it loses it (tracks
 * reconcile on their next sync). This command touches only preset YAMLs — the
 * caller removes the FX from the track separately and re-inspects.
 *
 * A deleted slot is referenced everywhere as `"<presetName>/<slotId>"` — that
 * holds whether it's the source's own composition fields or a composed preset
 * that imports the source (the ref prefix is always the owning source's
 * name). So one ref string covers every site.
 */
export function deletePlugin(
  input: DeletePluginInput,
  reabasePath: string
): DeletePluginOutput {
  const presetsDirectory = join(reabasePath, "presets");
  const { presets } = loadPresets(presetsDirectory);
  const definition = presets.get(input.presetName);
  if (!definition) {
    throw new Error(`Preset '${input.presetName}' not found`);
  }

  deletePresetOwnPlugin(definition, input.slotId);

  // Scrub the now-dangling ref from every preset's composition fields. The
  // resolver tolerates leftovers, but scrubbing keeps the YAML clean and
  // avoids a future plugin that reuses this slotId silently inheriting a
  // stale deactivate/exclude.
  const ref = `${input.presetName}/${input.slotId}`;
  for (const preset of presets.values()) {
    const scrubbed = scrubCompositionRef(preset, ref);
    if (scrubbed) {
      updateComposition(preset, scrubbed);
    }
  }

  return { success: true };
}

/**
 * Build the `updateComposition` field patch that removes `ref` from a preset's
 * `order` / `deactivated` / `excluded`. Returns only the fields that actually
 * contained the ref (so untouched fields are left alone), or `null` when none
 * did. An emptied list passes through as `[]`, which `updateComposition`
 * clears from the YAML.
 */
function scrubCompositionRef(
  preset: { order?: string[]; deactivated?: string[]; excluded?: string[] },
  ref: string
): { order?: string[]; deactivated?: string[]; excluded?: string[] } | null {
  const patch: { order?: string[]; deactivated?: string[]; excluded?: string[] } = {};
  let changed = false;
  for (const field of ["order", "deactivated", "excluded"] as const) {
    const list = preset[field];
    if (list && list.includes(ref)) {
      patch[field] = list.filter((entry) => entry !== ref);
      changed = true;
    }
  }
  return changed ? patch : null;
}

// ─── blob-only change promotion (Bug 4) ──────────────────────────

/**
 * Walk the merge's keep_base actions and, for any plugin whose normalized
 * stateBlob has changed since snapshot, promote the action (and the entry
 * in resolvedChain) to keep_local. This surfaces hidden state edits — like
 * a sample swap inside RS5K — at the per-plugin row, not just at the
 * track-level summary. Mutates `merge` in place.
 */
function promoteBlobOnlyChangesToKeepLocal(
  merge: MergeResult,
  snapshotChain: FxFingerprint[],
  currentChain: FxFingerprint[]
): void {
  const snapshotBySlot = new Map(snapshotChain.map((fx) => [fx.slotId, fx]));
  const currentBySlot = new Map(currentChain.map((fx) => [fx.slotId, fx]));
  const resolvedBySlot = new Map(
    merge.resolvedChain.map((fx, idx) => [fx.slotId, idx] as const)
  );

  for (let i = 0; i < merge.actions.length; i++) {
    const action = merge.actions[i];
    if (action.type !== "keep_base") continue;

    const snapshotFx = snapshotBySlot.get(action.fx.slotId);
    const currentFx = currentBySlot.get(action.fx.slotId);
    if (!snapshotFx?.stateBlob || !currentFx?.stateBlob) continue;

    const normalizedSnapshot = normalizeBlobForComparison(
      snapshotFx.stateBlob,
      snapshotFx.pluginType
    );
    const normalizedCurrent = normalizeBlobForComparison(
      currentFx.stateBlob,
      currentFx.pluginType
    );
    if (normalizedSnapshot === normalizedCurrent) continue;

    merge.actions[i] = { type: "keep_local", fx: currentFx };
    const resolvedIdx = resolvedBySlot.get(action.fx.slotId);
    if (resolvedIdx !== undefined) {
      merge.resolvedChain[resolvedIdx] = currentFx;
    }
  }
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
