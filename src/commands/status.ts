import { readFileSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";
import { parseRpp } from "../parser/parse.js";
import { getTracks, getTrackName, getTrackGuid, getExtState } from "../parser/helpers.js";
import { captureFxChain } from "../snapshot/capture.js";
import { findRppFiles } from "../utilities/files.js";
import { diffFxChains } from "../snapshot/diff.js";
import { readSnapshot } from "../snapshot/store.js";
import { adoptSlotMapAsBaselineIfIntact } from "../snapshot/adopt.js";
import { loadPresets } from "../preset/loader.js";
import { resolvePreset } from "../preset/resolver.js";
import { parseSlotMap, resolveSlotIds } from "../slot/map.js";

export interface TrackStatus {
  trackName: string;
  trackGuid: string;
  preset: string;
  projectPath: string;
  status:
    | "up-to-date"
    | "modified"
    | "upstream-changes"
    | "conflict"
    | "no-snapshot"
    | "unresolvable-preset";
  localChanges: number;
  upstreamChanges: number;
}

export interface StatusResult {
  reabasePath: string;
  tracks: TrackStatus[];
}

/**
 * Scan projects and report the status of all managed tracks.
 */
export function status(reabasePath: string): StatusResult {
  const presetsDirectory = join(reabasePath, "presets");
  const snapshotsDirectory = join(reabasePath, "snapshots");
  const projectRoot = resolve(reabasePath, "..");

  const presets = loadPresets(presetsDirectory);
  const rppFiles = findRppFiles(projectRoot);
  const tracks: TrackStatus[] = [];

  for (const rppFile of rppFiles) {
    const content = readFileSync(rppFile, "utf-8");
    const project = parseRpp(content);
    const projectTracks = getTracks(project);
    const relativeProjectPath = relative(projectRoot, rppFile);

    for (const track of projectTracks) {
      const preset = getExtState(track, "reabase_preset");
      if (!preset) continue;

      const trackName = getTrackName(track) ?? "unnamed";
      const trackGuid = getTrackGuid(track) ?? "unknown";

      // Compute snapshot path
      const projectName = basename(rppFile, ".RPP").toLowerCase();
      const snapshotPath = join(
        snapshotsDirectory,
        projectName,
        `${(trackGuid ?? "unnamed").replace(/[{}]/g, "").toLowerCase()}.json`
      );

      let snapshot = readSnapshot(snapshotPath);

      // Capture current state, resolving slotIds from stored slot map
      let currentChain = captureFxChain(track);
      const slotMapJson = getExtState(track, "reabase_slot_map");
      if (slotMapJson) {
        const slotMap = parseSlotMap(slotMapJson);
        if (slotMap) {
          currentChain = resolveSlotIds(currentChain, slotMap);
        }
      }

      // Resolve the current preset
      let resolvedPreset;
      try {
        resolvedPreset = resolvePreset(preset, presets, presetsDirectory);
      } catch {
        tracks.push({
          trackName,
          trackGuid,
          preset,
          projectPath: relativeProjectPath,
          status: "unresolvable-preset",
          localChanges: 0,
          upstreamChanges: 0,
        });
        continue;
      }

      if (!snapshot) {
        // Bug 1: a duplicated preset-bound track has slot_map + chain
        // copied via REAPER, but no snapshot at the new GUID. If the slot
        // map's hashes still match the live chain, adopt it as the new
        // baseline so status doesn't falsely report "Not yet synced".
        snapshot = adoptSlotMapAsBaselineIfIntact({
          trackName,
          trackGuid,
          preset,
          presetVersion: resolvedPreset.version,
          slotMapJson,
          currentChain,
          resolvedPresetSlotIds: new Set(resolvedPreset.fxChain.map((fx) => fx.slotId)),
          snapshotPath,
        });
      }

      if (!snapshot) {
        tracks.push({
          trackName,
          trackGuid,
          preset,
          projectPath: relativeProjectPath,
          status: "no-snapshot",
          localChanges: 0,
          upstreamChanges: 0,
        });
        continue;
      }

      // Compare: current vs. snapshot (local changes)
      const localDiff = diffFxChains(snapshot.fxChain, currentChain);
      const localChanges =
        localDiff.actions.filter((d) => d.type !== "unchanged").length +
        (localDiff.reordered ? 1 : 0);

      // Compare: snapshot vs. current preset (upstream changes)
      const upstreamDiff = diffFxChains(
        snapshot.fxChain,
        resolvedPreset.fxChain
      );
      const upstreamChanges =
        upstreamDiff.actions.filter((d) => d.type !== "unchanged").length +
        (upstreamDiff.reordered ? 1 : 0);

      let statusValue: TrackStatus["status"];
      if (localChanges > 0 && upstreamChanges > 0) {
        statusValue = "conflict";
      } else if (localChanges > 0) {
        statusValue = "modified";
      } else if (upstreamChanges > 0) {
        statusValue = "upstream-changes";
      } else {
        statusValue = "up-to-date";
      }

      tracks.push({
        trackName,
        trackGuid,
        preset,
        projectPath: relativeProjectPath,
        status: statusValue,
        localChanges,
        upstreamChanges,
      });
    }
  }

  return { reabasePath, tracks };
}
