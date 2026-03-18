/**
 * A single FX parameter value captured via TrackFX_GetParam.
 */
export interface ParameterValue {
  name: string;
  value: number;
}

/**
 * A fingerprint of a single FX plugin's state.
 * Used for change detection and three-way merge.
 */
export interface FxFingerprint {
  /** Plugin display name, e.g., "AU: T-De-Esser 2 (Techivation)" */
  pluginName: string;
  /** Plugin type: "AU", "VST", "VST3", "JS", "DX" */
  pluginType: string;
  /** SHA-256 hash of the parameters for quick equality checks */
  stateHash: string;
  /** Stable slot identifier, e.g., "t-de-esser-2" */
  slotId: string;
  /**
   * Additional opening-line params beyond pluginName.
   * For AU: [manufacturer:name, "", auType, auSubtype, auManufacturer]
   * For VST/VST3: [dllPath, flags, chunkId, ...]
   * Needed to reconstruct the full plugin block so REAPER can load it.
   */
  pluginParams?: (string | number)[];
  /** Preset name that owns this plugin's state (set during resolution) */
  origin?: string;
  /** Parameter values captured via TrackFX_GetParam (keyed by param index as string) */
  parameters: Record<string, ParameterValue>;
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
