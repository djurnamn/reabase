/**
 * A fingerprint of a single FX plugin's state.
 * Used for change detection and three-way merge.
 */
export interface FxFingerprint {
  /** Plugin display name, e.g., "AU: T-De-Esser 2 (Techivation)" */
  pluginName: string;
  /** Plugin type: "AU", "VST", "VST3", "JS", "DX" */
  pluginType: string;
  /** SHA-256 hash of the state blob for quick equality checks */
  stateHash: string;
  /** Full base64-encoded plugin state (for reconstruction) */
  stateBlob: string;
  /** Stable slot identifier, e.g., "t-de-esser-2" */
  slotId: string;
  /** Preset name that owns this plugin's state (set during resolution) */
  origin?: string;
}

/**
 * A snapshot of a track's FX chain state at a point in time.
 * Stored in .reabase/snapshots/ and used as the "old base" in three-way merge.
 */
export interface Snapshot {
  version: 1;
  trackGuid: string;
  trackName: string;
  preset: string;
  presetVersion: string;
  capturedAt: string;
  fxChain: FxFingerprint[];
}
