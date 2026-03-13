import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";
import { parseRpp } from "../parser/parse.js";
import { serializeRpp, detectLineEnding } from "../parser/serialize.js";
import {
  getTracks,
  getTrackName,
  getTrackGuid,
  getExtState,
  setExtState,
} from "../parser/helpers.js";
import { findRppFiles } from "../utilities/files.js";
import { captureFxChain } from "../snapshot/capture.js";
import { readSnapshot, writeSnapshot } from "../snapshot/store.js";
import { loadPresets } from "../preset/loader.js";
import { resolvePreset } from "../preset/resolver.js";
import { threeWayMerge } from "../merge/three-way.js";
import { createBackup } from "../utilities/backup.js";
import { isProjectOpen } from "../utilities/reaper-detect.js";
import { buildSlotMap, serializeSlotMap } from "../slot/map.js";
import type { MergeResult } from "../merge/types.js";
import type { Snapshot } from "../snapshot/types.js";
import type { RppNode } from "../parser/types.js";
import { applyResolvedChainToTrack } from "./apply.js";

export interface SyncPlan {
  projectPath: string;
  trackActions: TrackSyncAction[];
}

export interface TrackSyncAction {
  trackName: string;
  trackGuid: string;
  preset: string;
  merge: MergeResult;
}

export interface SyncResult {
  plans: SyncPlan[];
  errors: string[];
  applied: boolean;
}

/**
 * Plan the sync: compute merges for all managed tracks across all projects.
 * Does NOT write anything — call `executeSync` to apply.
 */
export function planSync(reabasePath: string): SyncPlan[] {
  const presetsDirectory = join(reabasePath, "presets");
  const snapshotsDirectory = join(reabasePath, "snapshots");
  const projectRoot = resolve(reabasePath, "..");

  const presets = loadPresets(presetsDirectory);
  const rppFiles = findRppFiles(projectRoot);
  const plans: SyncPlan[] = [];

  for (const rppFile of rppFiles) {
    const content = readFileSync(rppFile, "utf-8");
    const project = parseRpp(content);
    const tracks = getTracks(project);
    const trackActions: TrackSyncAction[] = [];

    for (const track of tracks) {
      const preset = getExtState(track, "reabase_preset");
      if (!preset) continue;

      const trackName = getTrackName(track) ?? "unnamed";
      const trackGuid = getTrackGuid(track) ?? "unknown";

      // Resolve preset
      let resolvedPreset;
      try {
        resolvedPreset = resolvePreset(preset, presets, presetsDirectory);
      } catch {
        continue; // Skip tracks with unresolvable presets
      }

      // Load snapshot
      const projectName = basename(rppFile, ".RPP").toLowerCase();
      const snapshotPath = join(
        snapshotsDirectory,
        projectName,
        `${trackName.toLowerCase()}.json`
      );
      const snapshot = readSnapshot(snapshotPath);

      if (!snapshot) {
        // No snapshot = first sync. Treat as fresh apply (old base = empty).
        const currentChain = captureFxChain(track);
        const merge = threeWayMerge([], resolvedPreset.fxChain, currentChain);

        if (merge.actions.length > 0) {
          trackActions.push({ trackName, trackGuid, preset, merge });
        }
        continue;
      }

      // Three-way merge
      const currentChain = captureFxChain(track);
      const merge = threeWayMerge(
        snapshot.fxChain,
        resolvedPreset.fxChain,
        currentChain
      );

      // Only include if there's something to do
      const hasChanges = merge.actions.some(
        (a) =>
          a.type !== "keep_base" &&
          a.type !== "keep_local"
      );

      if (hasChanges) {
        trackActions.push({ trackName, trackGuid, preset, merge });
      }
    }

    if (trackActions.length > 0) {
      plans.push({
        projectPath: relative(projectRoot, rppFile),
        trackActions,
      });
    }
  }

  return plans;
}

/**
 * Execute a sync plan: apply merges and write updated RPP files.
 */
export function executeSync(
  reabasePath: string,
  plans: SyncPlan[]
): SyncResult {
  const presetsDirectory = join(reabasePath, "presets");
  const snapshotsDirectory = join(reabasePath, "snapshots");
  const projectRoot = resolve(reabasePath, "..");

  const presets = loadPresets(presetsDirectory);
  const errors: string[] = [];

  for (const plan of plans) {
    const rppPath = resolve(projectRoot, plan.projectPath);

    // Safety: check if project is open in REAPER
    if (isProjectOpen(rppPath)) {
      errors.push(
        `Skipping ${plan.projectPath}: project appears to be open in REAPER. Close it first.`
      );
      continue;
    }

    // Safety: check for conflicts
    const hasConflicts = plan.trackActions.some((a) => a.merge.hasConflicts);
    if (hasConflicts) {
      errors.push(
        `Skipping ${plan.projectPath}: has unresolved conflicts. Resolve them first.`
      );
      continue;
    }

    // Create backup
    try {
      createBackup(rppPath);
    } catch (error) {
      errors.push(
        `Failed to create backup of ${plan.projectPath}: ${error}`
      );
      continue;
    }

    // Parse and modify the project
    const content = readFileSync(rppPath, "utf-8");
    const lineEnding = detectLineEnding(content);
    const project = parseRpp(content);
    const tracks = getTracks(project);

    for (const action of plan.trackActions) {
      // Find the track by GUID
      const track = tracks.find(
        (t) => getTrackGuid(t) === action.trackGuid
      );
      if (!track) {
        errors.push(
          `Track '${action.trackName}' (${action.trackGuid}) not found in ${plan.projectPath}`
        );
        continue;
      }

      // Apply the resolved chain to the track
      applyResolvedChainToTrack(track, action.merge.resolvedChain);

      // Write slot map to P_EXT
      const slotMap = buildSlotMap(action.merge.resolvedChain);
      setExtState(track, "reabase_slot_map", serializeSlotMap(slotMap));

      // Update snapshot
      const projectName = basename(rppPath, ".RPP").toLowerCase();
      const snapshotPath = join(
        snapshotsDirectory,
        projectName,
        `${action.trackName.toLowerCase()}.json`
      );

      const resolvedPreset = resolvePreset(
        action.preset,
        presets,
        presetsDirectory
      );

      const snapshot: Snapshot = {
        version: 1,
        trackGuid: action.trackGuid,
        trackName: action.trackName,
        preset: action.preset,
        presetVersion: resolvedPreset.version,
        capturedAt: new Date().toISOString(),
        fxChain: action.merge.resolvedChain,
      };
      writeSnapshot(snapshotPath, snapshot);
    }

    // Write updated project
    const output = serializeRpp(project, { lineEnding });
    writeFileSync(rppPath, output, "utf-8");
  }

  return {
    plans,
    errors,
    applied: errors.length === 0,
  };
}
