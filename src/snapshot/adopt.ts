import type { FxFingerprint, Snapshot } from "./types.js";
import { parseSlotMap } from "../slot/map.js";
import { writeSnapshot } from "./store.js";

export interface AdoptBaselineInput {
  trackName: string;
  trackGuid: string;
  preset: string;
  presetVersion: string;
  slotMapJson: string | null | undefined;
  currentChain: FxFingerprint[];
  resolvedPresetSlotIds: Set<string>;
  snapshotPath: string;
}

/**
 * Bug 1 fix: when a track has a slot map but no snapshot file (typical
 * after the user duplicates a bound track in REAPER), check whether the
 * slot map's stored stateHashes still match the live chain. If they do,
 * the track is intact relative to its last baseline and we can write a
 * fresh snapshot at the new GUID instead of forcing the user through a
 * destructive "Apply preset changes" path.
 *
 * Returns the adopted snapshot, or null if the chain has diverged from
 * the slot map (real local edits — let the no-snapshot path handle it).
 */
export function adoptSlotMapAsBaselineIfIntact(
  input: AdoptBaselineInput
): Snapshot | null {
  if (!input.slotMapJson) return null;
  const slotMap = parseSlotMap(input.slotMapJson);
  if (!slotMap) return null;
  if (Object.keys(slotMap).length === 0) return null;

  // Every slot in the map must be present in the live chain with a
  // matching stateHash. Plugins on the track that aren't in the slot map
  // (local additions) don't block adoption — they were already treated as
  // unmanaged before duplication.
  const currentBySlot = new Map(input.currentChain.map((fx) => [fx.slotId, fx]));
  for (const [slotId, entry] of Object.entries(slotMap)) {
    const fx = currentBySlot.get(slotId);
    if (!fx) return null;
    if (fx.stateHash !== entry.stateHash) return null;
  }

  // Snapshot only the preset-managed slots (mirrors snapshotTrack).
  const snapshotChain = input.currentChain.filter((fx) =>
    input.resolvedPresetSlotIds.has(fx.slotId)
  );

  const snapshot: Snapshot = {
    version: 1,
    trackGuid: input.trackGuid,
    trackName: input.trackName,
    preset: input.preset,
    presetVersion: input.presetVersion,
    capturedAt: new Date().toISOString(),
    fxChain: snapshotChain,
  };
  writeSnapshot(input.snapshotPath, snapshot);
  return snapshot;
}
